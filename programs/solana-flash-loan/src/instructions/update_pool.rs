use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::FlashLoanError;
use crate::state::LendingPool;

#[derive(Accounts)]
pub struct UpdatePoolConfig<'info> {
    #[account(
        mut,
        seeds = [LENDING_POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.bump,
        constraint = pool.admin == admin.key() @ FlashLoanError::Unauthorized,
    )]
    pub pool: Account<'info, LendingPool>,

    pub admin: Signer<'info>,
}

pub fn handle_update_pool(
    ctx: Context<UpdatePoolConfig>,
    new_fee_basis_points: Option<u16>,
    is_active: Option<bool>,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    if let Some(fee) = new_fee_basis_points {
        require!(fee <= MAX_FEE_BASIS_POINTS, FlashLoanError::InvalidFee);
        pool.fee_basis_points = fee;
    }

    if let Some(active) = is_active {
        pool.is_active = active;
    }

    Ok(())
}
