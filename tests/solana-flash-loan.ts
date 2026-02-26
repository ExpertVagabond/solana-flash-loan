import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaFlashLoan } from "../target/types/solana_flash_loan";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

describe("solana-flash-loan", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .solanaFlashLoan as Program<SolanaFlashLoan>;

  const admin = Keypair.generate();
  const depositor = Keypair.generate();
  const borrower = Keypair.generate();
  let tokenMint: PublicKey;
  let adminTokenAccount: PublicKey;
  let depositorTokenAccount: PublicKey;
  let borrowerTokenAccount: PublicKey;
  let poolPda: PublicKey;
  let poolBump: number;
  let vaultPda: PublicKey;
  let receiptPda: PublicKey;

  const FEE_BASIS_POINTS = 9; // 0.09%
  const DEPOSIT_AMOUNT = 1_000_000_000; // 1B tokens (6 decimals = 1000 USDC)
  const BORROW_AMOUNT = 500_000_000; // 500M tokens (500 USDC)

  before(async () => {
    // Airdrop SOL to all participants
    const airdropAmount = 10 * anchor.web3.LAMPORTS_PER_SOL;
    await Promise.all([
      provider.connection
        .requestAirdrop(admin.publicKey, airdropAmount)
        .then((sig) => provider.connection.confirmTransaction(sig)),
      provider.connection
        .requestAirdrop(depositor.publicKey, airdropAmount)
        .then((sig) => provider.connection.confirmTransaction(sig)),
      provider.connection
        .requestAirdrop(borrower.publicKey, airdropAmount)
        .then((sig) => provider.connection.confirmTransaction(sig)),
    ]);

    // Create token mint
    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create token accounts
    adminTokenAccount = await createAccount(
      provider.connection,
      admin,
      tokenMint,
      admin.publicKey
    );
    depositorTokenAccount = await createAccount(
      provider.connection,
      depositor,
      tokenMint,
      depositor.publicKey
    );
    borrowerTokenAccount = await createAccount(
      provider.connection,
      borrower,
      tokenMint,
      borrower.publicKey
    );

    // Mint tokens to depositor
    await mintTo(
      provider.connection,
      admin,
      tokenMint,
      depositorTokenAccount,
      admin,
      DEPOSIT_AMOUNT
    );

    // Derive PDAs
    [poolPda, poolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("lending_pool"), tokenMint.toBuffer()],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_vault"), poolPda.toBuffer()],
      program.programId
    );
    [receiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("deposit_receipt"),
        poolPda.toBuffer(),
        depositor.publicKey.toBuffer(),
      ],
      program.programId
    );
  });

  it("initializes a lending pool", async () => {
    const tx = await program.methods
      .initializePool(FEE_BASIS_POINTS)
      .accountsStrict({
        pool: poolPda,
        tokenMint,
        vault: vaultPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    console.log("  initialize_pool tx:", tx);

    const pool = await program.account.lendingPool.fetch(poolPda);
    assert.ok(pool.admin.equals(admin.publicKey));
    assert.ok(pool.tokenMint.equals(tokenMint));
    assert.ok(pool.vault.equals(vaultPda));
    assert.equal(pool.feeBasisPoints, FEE_BASIS_POINTS);
    assert.equal(pool.totalDeposits.toNumber(), 0);
    assert.equal(pool.totalShares.toNumber(), 0);
    assert.equal(pool.isActive, true);
  });

  it("accepts deposits and mints shares", async () => {
    const tx = await program.methods
      .deposit(new anchor.BN(DEPOSIT_AMOUNT))
      .accountsStrict({
        pool: poolPda,
        receipt: receiptPda,
        vault: vaultPda,
        depositorTokenAccount,
        depositor: depositor.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();

    console.log("  deposit tx:", tx);

    const pool = await program.account.lendingPool.fetch(poolPda);
    assert.equal(pool.totalDeposits.toNumber(), DEPOSIT_AMOUNT);
    assert.equal(pool.totalShares.toNumber(), DEPOSIT_AMOUNT); // First deposit: 1:1

    const receipt = await program.account.depositReceipt.fetch(receiptPda);
    assert.equal(receipt.shares.toNumber(), DEPOSIT_AMOUNT);
    assert.ok(receipt.depositor.equals(depositor.publicKey));

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    assert.equal(Number(vaultBalance.amount), DEPOSIT_AMOUNT);
  });

  it("issues a flash loan and verifies receipt", async () => {
    // Derive flash loan receipt PDA
    const [flashReceiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("flash_loan_receipt"),
        poolPda.toBuffer(),
        borrower.publicKey.toBuffer(),
      ],
      program.programId
    );

    const tx = await program.methods
      .borrowFlashLoan(new anchor.BN(BORROW_AMOUNT))
      .accountsStrict({
        pool: poolPda,
        flashLoanReceipt: flashReceiptPda,
        vault: vaultPda,
        borrowerTokenAccount,
        borrower: borrower.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([borrower])
      .rpc();

    console.log("  borrow_flash_loan tx:", tx);

    // Verify borrower received the tokens
    const borrowerBalance = await getAccount(
      provider.connection,
      borrowerTokenAccount
    );
    assert.equal(Number(borrowerBalance.amount), BORROW_AMOUNT);

    // Verify receipt was created
    const flashReceipt =
      await program.account.flashLoanReceipt.fetch(flashReceiptPda);
    assert.equal(flashReceipt.amount.toNumber(), BORROW_AMOUNT);
    assert.ok(!flashReceipt.repaid);

    // Calculate expected fee: 500_000_000 * 9 / 10000 = 450_000
    const expectedFee = Math.floor((BORROW_AMOUNT * FEE_BASIS_POINTS) / 10000);
    assert.equal(flashReceipt.fee.toNumber(), expectedFee);
  });

  it("repays flash loan with fee", async () => {
    const [flashReceiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("flash_loan_receipt"),
        poolPda.toBuffer(),
        borrower.publicKey.toBuffer(),
      ],
      program.programId
    );

    const expectedFee = Math.floor((BORROW_AMOUNT * FEE_BASIS_POINTS) / 10000);
    const repayAmount = BORROW_AMOUNT + expectedFee;

    // Mint extra tokens to borrower to cover the fee (simulating profit from arb)
    await mintTo(
      provider.connection,
      admin,
      tokenMint,
      borrowerTokenAccount,
      admin,
      expectedFee
    );

    const poolBefore = await program.account.lendingPool.fetch(poolPda);

    const tx = await program.methods
      .repayFlashLoan()
      .accountsStrict({
        pool: poolPda,
        flashLoanReceipt: flashReceiptPda,
        vault: vaultPda,
        borrowerTokenAccount,
        borrower: borrower.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([borrower])
      .rpc();

    console.log("  repay_flash_loan tx:", tx);

    // Verify borrower balance is 0 (repaid all)
    const borrowerBalance = await getAccount(
      provider.connection,
      borrowerTokenAccount
    );
    assert.equal(Number(borrowerBalance.amount), 0);

    // Verify vault received principal + fee
    const vaultBalance = await getAccount(provider.connection, vaultPda);
    assert.equal(
      Number(vaultBalance.amount),
      DEPOSIT_AMOUNT + expectedFee
    );

    // Verify pool state updated
    const pool = await program.account.lendingPool.fetch(poolPda);
    assert.equal(
      pool.totalDeposits.toNumber(),
      DEPOSIT_AMOUNT + expectedFee
    );
    assert.equal(pool.totalFeesEarned.toNumber(), expectedFee);

    // Verify receipt was closed (account no longer exists — rent refunded to borrower)
    try {
      await program.account.flashLoanReceipt.fetch(flashReceiptPda);
      assert.fail("Receipt should have been closed");
    } catch (err) {
      assert.include(err.toString(), "Account does not exist");
    }
  });

  it("allows LP to withdraw with accrued fees", async () => {
    const receiptBefore =
      await program.account.depositReceipt.fetch(receiptPda);
    const poolBefore = await program.account.lendingPool.fetch(poolPda);

    // Withdraw all shares
    const tx = await program.methods
      .withdraw(receiptBefore.shares)
      .accountsStrict({
        pool: poolPda,
        receipt: receiptPda,
        vault: vaultPda,
        depositorTokenAccount,
        depositor: depositor.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();

    console.log("  withdraw tx:", tx);

    // Depositor should get original deposit + fee share
    const depositorBalance = await getAccount(
      provider.connection,
      depositorTokenAccount
    );
    const expectedFee = Math.floor((BORROW_AMOUNT * FEE_BASIS_POINTS) / 10000);
    assert.equal(
      Number(depositorBalance.amount),
      DEPOSIT_AMOUNT + expectedFee
    );

    // Pool should be empty
    const pool = await program.account.lendingPool.fetch(poolPda);
    assert.equal(pool.totalDeposits.toNumber(), 0);
    assert.equal(pool.totalShares.toNumber(), 0);
  });

  it("admin can pause pool and block borrows, then unpause", async () => {
    // Re-deposit so pool has liquidity for later tests
    await mintTo(
      provider.connection,
      admin,
      tokenMint,
      depositorTokenAccount,
      admin,
      DEPOSIT_AMOUNT
    );

    await program.methods
      .deposit(new anchor.BN(DEPOSIT_AMOUNT))
      .accountsStrict({
        pool: poolPda,
        receipt: receiptPda,
        vault: vaultPda,
        depositorTokenAccount,
        depositor: depositor.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();

    // Pause pool
    await program.methods
      .updatePoolConfig(null, false)
      .accountsStrict({
        pool: poolPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    let pool = await program.account.lendingPool.fetch(poolPda);
    assert.equal(pool.isActive, false);

    // Try to borrow — should fail with PoolPaused
    // Use a new borrower2 so we don't conflict with existing flash_loan_receipt PDA
    const borrower2 = Keypair.generate();
    await provider.connection
      .requestAirdrop(borrower2.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL)
      .then((sig) => provider.connection.confirmTransaction(sig));

    const borrower2TokenAccount = await createAccount(
      provider.connection,
      borrower2,
      tokenMint,
      borrower2.publicKey
    );

    const [flashReceiptPda2] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("flash_loan_receipt"),
        poolPda.toBuffer(),
        borrower2.publicKey.toBuffer(),
      ],
      program.programId
    );

    try {
      await program.methods
        .borrowFlashLoan(new anchor.BN(100))
        .accountsStrict({
          pool: poolPda,
          flashLoanReceipt: flashReceiptPda2,
          vault: vaultPda,
          borrowerTokenAccount: borrower2TokenAccount,
          borrower: borrower2.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([borrower2])
        .rpc();
      assert.fail("Should have rejected borrow on paused pool");
    } catch (err) {
      assert.include(err.toString(), "PoolPaused");
    }

    // Unpause
    await program.methods
      .updatePoolConfig(null, true)
      .accountsStrict({
        pool: poolPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    pool = await program.account.lendingPool.fetch(poolPda);
    assert.equal(pool.isActive, true);
  });

  it("rejects unauthorized admin actions", async () => {
    const fakeAdmin = Keypair.generate();
    await provider.connection
      .requestAirdrop(fakeAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then((sig) => provider.connection.confirmTransaction(sig));

    try {
      await program.methods
        .updatePoolConfig(100, null)
        .accountsStrict({
          pool: poolPda,
          admin: fakeAdmin.publicKey,
        })
        .signers([fakeAdmin])
        .rpc();
      assert.fail("Should have rejected unauthorized admin");
    } catch (err) {
      assert.include(err.toString(), "Unauthorized");
    }
  });

  it("rejects borrow exceeding pool liquidity", async () => {
    const overBorrower = Keypair.generate();
    await provider.connection
      .requestAirdrop(overBorrower.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL)
      .then((sig) => provider.connection.confirmTransaction(sig));

    const overBorrowerTokenAccount = await createAccount(
      provider.connection,
      overBorrower,
      tokenMint,
      overBorrower.publicKey
    );

    const [overFlashReceiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("flash_loan_receipt"),
        poolPda.toBuffer(),
        overBorrower.publicKey.toBuffer(),
      ],
      program.programId
    );

    const pool = await program.account.lendingPool.fetch(poolPda);
    const tooMuch = pool.totalDeposits.toNumber() + 1;

    try {
      await program.methods
        .borrowFlashLoan(new anchor.BN(tooMuch))
        .accountsStrict({
          pool: poolPda,
          flashLoanReceipt: overFlashReceiptPda,
          vault: vaultPda,
          borrowerTokenAccount: overBorrowerTokenAccount,
          borrower: overBorrower.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([overBorrower])
        .rpc();
      assert.fail("Should have rejected over-borrow");
    } catch (err) {
      assert.include(err.toString(), "InsufficientLiquidity");
    }
  });
});
