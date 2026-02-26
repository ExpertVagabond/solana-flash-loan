use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::FlashLoanError;
use crate::events::LiquidityDeposited;
use crate::state::{DepositReceipt, LendingPool};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [LENDING_POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.bump,
        constraint = pool.is_active @ FlashLoanError::PoolPaused,
    )]
    pub pool: Account<'info, LendingPool>,

    #[account(
        init_if_needed,
        seeds = [DEPOSIT_RECEIPT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump,
        payer = depositor,
        space = DepositReceipt::SIZE,
    )]
    pub receipt: Account<'info, DepositReceipt>,

    #[account(
        mut,
        constraint = vault.key() == pool.vault @ FlashLoanError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_token_account.mint == pool.token_mint @ FlashLoanError::MintMismatch,
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, FlashLoanError::ZeroDeposit);

    let pool = &mut ctx.accounts.pool;

    // Calculate shares: first deposit gets 1:1, subsequent are proportional
    let shares = if pool.total_shares == 0 {
        amount
    } else {
        amount
            .checked_mul(pool.total_shares)
            .ok_or(FlashLoanError::MathOverflow)?
            .checked_div(pool.total_deposits)
            .ok_or(FlashLoanError::MathOverflow)?
    };

    // Transfer tokens from depositor to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    // Update pool state
    pool.total_deposits = pool
        .total_deposits
        .checked_add(amount)
        .ok_or(FlashLoanError::MathOverflow)?;
    pool.total_shares = pool
        .total_shares
        .checked_add(shares)
        .ok_or(FlashLoanError::MathOverflow)?;

    // Update receipt
    let receipt = &mut ctx.accounts.receipt;
    if receipt.pool == Pubkey::default() {
        // First deposit — initialize receipt fields
        receipt.pool = pool.key();
        receipt.depositor = ctx.accounts.depositor.key();
        receipt.bump = ctx.bumps.receipt;
    }
    receipt.shares = receipt
        .shares
        .checked_add(shares)
        .ok_or(FlashLoanError::MathOverflow)?;
    receipt.last_deposit_ts = Clock::get()?.unix_timestamp;

    emit!(LiquidityDeposited {
        pool: pool.key(),
        depositor: ctx.accounts.depositor.key(),
        amount,
        shares_minted: shares,
    });

    Ok(())
}
