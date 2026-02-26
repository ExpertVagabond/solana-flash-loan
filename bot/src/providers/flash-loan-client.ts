import { Program, AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import {
  PublicKey,
  TransactionInstruction,
  Connection,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type pino from "pino";

// Load IDL from copied file
import IDL from "../../idl/solana_flash_loan.json";

const LENDING_POOL_SEED = Buffer.from("lending_pool");
const POOL_VAULT_SEED = Buffer.from("pool_vault");
const FLASH_LOAN_RECEIPT_SEED = Buffer.from("flash_loan_receipt");

export interface PoolState {
  admin: PublicKey;
  tokenMint: PublicKey;
  vault: PublicKey;
  totalDeposits: BN;
  totalShares: BN;
  totalFeesEarned: BN;
  feeBasisPoints: number;
  bump: number;
  vaultBump: number;
  isActive: boolean;
}

export class FlashLoanClient {
  private program: Program;
  private programId: PublicKey;
  private tokenMint: PublicKey;
  private logger: pino.Logger;

  public poolPda: PublicKey;
  public poolBump: number;
  public vaultPda: PublicKey;

  constructor(
    connection: Connection,
    programId: PublicKey,
    tokenMint: PublicKey,
    payer: Keypair,
    logger: pino.Logger
  ) {
    this.programId = programId;
    this.tokenMint = tokenMint;
    this.logger = logger;

    // Create a minimal provider (we won't send txs through it)
    const wallet = new Wallet(payer);
    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });

    this.program = new Program(IDL as any, provider);

    // Derive PDAs
    const [poolPda, poolBump] = PublicKey.findProgramAddressSync(
      [LENDING_POOL_SEED, tokenMint.toBuffer()],
      programId
    );
    this.poolPda = poolPda;
    this.poolBump = poolBump;

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [POOL_VAULT_SEED, poolPda.toBuffer()],
      programId
    );
    this.vaultPda = vaultPda;
  }

  deriveFlashReceiptPda(borrower: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [FLASH_LOAN_RECEIPT_SEED, this.poolPda.toBuffer(), borrower.toBuffer()],
      this.programId
    );
  }

  async getPoolState(): Promise<PoolState> {
    const pool = await (this.program.account as any).lendingPool.fetch(
      this.poolPda
    );
    return {
      admin: pool.admin,
      tokenMint: pool.tokenMint,
      vault: pool.vault,
      totalDeposits: pool.totalDeposits,
      totalShares: pool.totalShares,
      totalFeesEarned: pool.totalFeesEarned,
      feeBasisPoints: pool.feeBasisPoints,
      bump: pool.bump,
      vaultBump: pool.vaultBump,
      isActive: pool.isActive,
    };
  }

  async buildBorrowIx(
    borrower: PublicKey,
    borrowerTokenAccount: PublicKey,
    amount: BN
  ): Promise<TransactionInstruction> {
    const [flashReceiptPda] = this.deriveFlashReceiptPda(borrower);

    return await this.program.methods
      .borrowFlashLoan(amount)
      .accountsStrict({
        pool: this.poolPda,
        flashLoanReceipt: flashReceiptPda,
        vault: this.vaultPda,
        borrowerTokenAccount,
        borrower,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async buildRepayIx(
    borrower: PublicKey,
    borrowerTokenAccount: PublicKey
  ): Promise<TransactionInstruction> {
    const [flashReceiptPda] = this.deriveFlashReceiptPda(borrower);

    return await this.program.methods
      .repayFlashLoan()
      .accountsStrict({
        pool: this.poolPda,
        flashLoanReceipt: flashReceiptPda,
        vault: this.vaultPda,
        borrowerTokenAccount,
        borrower,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }
}
