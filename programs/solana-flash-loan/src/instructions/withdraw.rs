use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::FlashLoanError;
use crate::events::LiquidityWithdrawn;
use crate::state::{DepositReceipt, LendingPool};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [LENDING_POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [DEPOSIT_RECEIPT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump = receipt.bump,
        constraint = receipt.depositor == depositor.key() @ FlashLoanError::Unauthorized,
        constraint = receipt.pool == pool.key() @ FlashLoanError::InvalidVault,
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

    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, shares_to_burn: u64) -> Result<()> {
    require!(shares_to_burn > 0, FlashLoanError::ZeroWithdraw);

    let receipt = &ctx.accounts.receipt;
    require!(
        receipt.shares >= shares_to_burn,
        FlashLoanError::InsufficientShares
    );

    let pool = &ctx.accounts.pool;

    // Calculate token amount for these shares (includes accrued fees)
    // Use u128 intermediate to avoid overflow: (shares * deposits) / total_shares
    let amount = (shares_to_burn as u128)
        .checked_mul(pool.total_deposits as u128)
        .ok_or(FlashLoanError::MathOverflow)?
        .checked_div(pool.total_shares as u128)
        .ok_or(FlashLoanError::MathOverflow)? as u64;

    // PDA signer seeds for vault transfer
    let mint_key = pool.token_mint;
    let pool_seeds = &[
        LENDING_POOL_SEED,
        mint_key.as_ref(),
        &[pool.bump],
    ];

    // Transfer tokens from vault to depositor (PDA-signed)
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.depositor_token_account.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount,
    )?;

    // Update pool state
    let pool = &mut ctx.accounts.pool;
    pool.total_deposits = pool
        .total_deposits
        .checked_sub(amount)
        .ok_or(FlashLoanError::MathOverflow)?;
    pool.total_shares = pool
        .total_shares
        .checked_sub(shares_to_burn)
        .ok_or(FlashLoanError::MathOverflow)?;

    // Update receipt
    let receipt = &mut ctx.accounts.receipt;
    receipt.shares = receipt
        .shares
        .checked_sub(shares_to_burn)
        .ok_or(FlashLoanError::MathOverflow)?;

    emit!(LiquidityWithdrawn {
        pool: pool.key(),
        depositor: ctx.accounts.depositor.key(),
        amount,
        shares_burned: shares_to_burn,
    });

    Ok(())
}
