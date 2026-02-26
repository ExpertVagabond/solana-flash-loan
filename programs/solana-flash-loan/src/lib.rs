use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("2chVPk6DV21qWuyUA2eHAzATdFSHM7ykv1fVX7Gv6nor");

#[program]
pub mod solana_flash_loan {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, fee_basis_points: u16) -> Result<()> {
        instructions::initialize_pool::handle_initialize_pool(ctx, fee_basis_points)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, shares_to_burn: u64) -> Result<()> {
        instructions::withdraw::handle_withdraw(ctx, shares_to_burn)
    }

    pub fn borrow_flash_loan(ctx: Context<BorrowFlashLoan>, amount: u64) -> Result<()> {
        instructions::flash_loan::borrow_handler(ctx, amount)
    }

    pub fn repay_flash_loan(ctx: Context<RepayFlashLoan>) -> Result<()> {
        instructions::flash_loan::repay_handler(ctx)
    }

    pub fn update_pool_config(
        ctx: Context<UpdatePoolConfig>,
        new_fee_basis_points: Option<u16>,
        is_active: Option<bool>,
    ) -> Result<()> {
        instructions::update_pool::handle_update_pool(ctx, new_fee_basis_points, is_active)
    }
}
