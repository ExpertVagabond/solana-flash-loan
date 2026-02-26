use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::FlashLoanError;
use crate::events::PoolInitialized;
use crate::state::LendingPool;

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        seeds = [LENDING_POOL_SEED, token_mint.key().as_ref()],
        bump,
        payer = admin,
        space = LendingPool::SIZE,
    )]
    pub pool: Account<'info, LendingPool>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        seeds = [POOL_VAULT_SEED, pool.key().as_ref()],
        bump,
        payer = admin,
        token::mint = token_mint,
        token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_initialize_pool(ctx: Context<InitializePool>, fee_basis_points: u16) -> Result<()> {
    require!(
        fee_basis_points <= MAX_FEE_BASIS_POINTS,
        FlashLoanError::InvalidFee
    );

    let pool = &mut ctx.accounts.pool;
    pool.admin = ctx.accounts.admin.key();
    pool.token_mint = ctx.accounts.token_mint.key();
    pool.vault = ctx.accounts.vault.key();
    pool.total_deposits = 0;
    pool.total_shares = 0;
    pool.total_fees_earned = 0;
    pool.fee_basis_points = fee_basis_points;
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.vault;
    pool.is_active = true;
    pool._reserved = [0u8; 64];

    emit!(PoolInitialized {
        pool: pool.key(),
        admin: pool.admin,
        token_mint: pool.token_mint,
        fee_basis_points,
    });

    Ok(())
}
