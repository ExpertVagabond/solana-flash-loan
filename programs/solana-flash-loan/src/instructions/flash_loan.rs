use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::FlashLoanError;
use crate::events::{FlashLoanBorrowed, FlashLoanRepaid};
use crate::state::{FlashLoanReceipt, LendingPool};

// ─── BORROW ─────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct BorrowFlashLoan<'info> {
    #[account(
        mut,
        seeds = [LENDING_POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.bump,
        constraint = pool.is_active @ FlashLoanError::PoolPaused,
    )]
    pub pool: Account<'info, LendingPool>,

    #[account(
        init,
        seeds = [FLASH_LOAN_RECEIPT_SEED, pool.key().as_ref(), borrower.key().as_ref()],
        bump,
        payer = borrower,
        space = FlashLoanReceipt::SIZE,
    )]
    pub flash_loan_receipt: Account<'info, FlashLoanReceipt>,

    #[account(
        mut,
        constraint = vault.key() == pool.vault @ FlashLoanError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = borrower_token_account.mint == pool.token_mint @ FlashLoanError::MintMismatch,
    )]
    pub borrower_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn borrow_handler(ctx: Context<BorrowFlashLoan>, amount: u64) -> Result<()> {
    require!(amount > 0, FlashLoanError::InvalidAmount);

    let vault = &ctx.accounts.vault;
    require!(
        vault.amount >= amount,
        FlashLoanError::InsufficientLiquidity
    );

    let pool = &ctx.accounts.pool;

    // Calculate fee: ceiling division to prevent zero-fee loans
    let fee = amount
        .checked_mul(pool.fee_basis_points as u64)
        .ok_or(FlashLoanError::MathOverflow)?
        .checked_add(9999)
        .ok_or(FlashLoanError::MathOverflow)?
        / 10_000;

    // Store the obligation in the receipt
    let receipt = &mut ctx.accounts.flash_loan_receipt;
    receipt.pool = pool.key();
    receipt.borrower = ctx.accounts.borrower.key();
    receipt.amount = amount;
    receipt.fee = fee;
    receipt.bump = ctx.bumps.flash_loan_receipt;

    // PDA signer seeds for vault transfer
    let mint_key = pool.token_mint;
    let pool_seeds = &[
        LENDING_POOL_SEED,
        mint_key.as_ref(),
        &[pool.bump],
    ];

    // Transfer tokens from vault to borrower
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.borrower_token_account.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount,
    )?;

    emit!(FlashLoanBorrowed {
        pool: pool.key(),
        borrower: ctx.accounts.borrower.key(),
        amount,
        fee,
    });

    Ok(())
}

// ─── REPAY ──────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RepayFlashLoan<'info> {
    #[account(
        mut,
        seeds = [LENDING_POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [FLASH_LOAN_RECEIPT_SEED, pool.key().as_ref(), borrower.key().as_ref()],
        bump = flash_loan_receipt.bump,
        close = borrower,
        constraint = flash_loan_receipt.borrower == borrower.key() @ FlashLoanError::Unauthorized,
        constraint = flash_loan_receipt.pool == pool.key() @ FlashLoanError::InvalidVault,
    )]
    pub flash_loan_receipt: Account<'info, FlashLoanReceipt>,

    #[account(
        mut,
        constraint = vault.key() == pool.vault @ FlashLoanError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = borrower_token_account.mint == pool.token_mint @ FlashLoanError::MintMismatch,
    )]
    pub borrower_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn repay_handler(ctx: Context<RepayFlashLoan>) -> Result<()> {
    let receipt = &ctx.accounts.flash_loan_receipt;
    let repayment = receipt
        .amount
        .checked_add(receipt.fee)
        .ok_or(FlashLoanError::MathOverflow)?;

    // Transfer repayment (principal + fee) from borrower to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.borrower_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.borrower.to_account_info(),
            },
        ),
        repayment,
    )?;

    // Update pool: fees increase total_deposits (shared among LP holders)
    let pool = &mut ctx.accounts.pool;
    pool.total_deposits = pool
        .total_deposits
        .checked_add(receipt.fee)
        .ok_or(FlashLoanError::MathOverflow)?;
    pool.total_fees_earned = pool
        .total_fees_earned
        .checked_add(receipt.fee)
        .ok_or(FlashLoanError::MathOverflow)?;

    emit!(FlashLoanRepaid {
        pool: pool.key(),
        borrower: ctx.accounts.borrower.key(),
        amount_repaid: repayment,
        fee_paid: receipt.fee,
    });

    // Receipt is closed by the `close = borrower` constraint — rent refunded to borrower

    Ok(())
}
