use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub fee_basis_points: u16,
}

#[event]
pub struct LiquidityDeposited {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub shares_minted: u64,
}

#[event]
pub struct LiquidityWithdrawn {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub shares_burned: u64,
}

#[event]
pub struct FlashLoanBorrowed {
    pub pool: Pubkey,
    pub borrower: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct FlashLoanRepaid {
    pub pool: Pubkey,
    pub borrower: Pubkey,
    pub amount_repaid: u64,
    pub fee_paid: u64,
}
