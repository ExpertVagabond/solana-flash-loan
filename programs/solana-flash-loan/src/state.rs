use anchor_lang::prelude::*;

#[account]
#[derive(Debug)]
pub struct LendingPool {
    /// Admin authority who created the pool
    pub admin: Pubkey,
    /// The SPL token mint this pool lends
    pub token_mint: Pubkey,
    /// The pool's token vault (PDA-owned)
    pub vault: Pubkey,
    /// Total deposits tracked (grows with fees)
    pub total_deposits: u64,
    /// Total shares issued to depositors
    pub total_shares: u64,
    /// Accumulated fees earned (lifetime counter)
    pub total_fees_earned: u64,
    /// Fee in basis points (e.g., 9 = 0.09%)
    pub fee_basis_points: u16,
    /// PDA bump seed
    pub bump: u8,
    /// Vault bump seed
    pub vault_bump: u8,
    /// Whether the pool is active
    pub is_active: bool,
    /// Reserved for future upgrades
    pub _reserved: [u8; 64],
}

impl LendingPool {
    pub const SIZE: usize = 8  // discriminator
        + 32   // admin
        + 32   // token_mint
        + 32   // vault
        + 8    // total_deposits
        + 8    // total_shares
        + 8    // total_fees_earned
        + 2    // fee_basis_points
        + 1    // bump
        + 1    // vault_bump
        + 1    // is_active
        + 64;  // _reserved
}

#[account]
#[derive(Debug)]
pub struct DepositReceipt {
    /// The lending pool this deposit belongs to
    pub pool: Pubkey,
    /// The depositor's wallet
    pub depositor: Pubkey,
    /// Shares owned by this depositor
    pub shares: u64,
    /// Timestamp of last deposit
    pub last_deposit_ts: i64,
    /// PDA bump
    pub bump: u8,
}

impl DepositReceipt {
    pub const SIZE: usize = 8  // discriminator
        + 32   // pool
        + 32   // depositor
        + 8    // shares
        + 8    // last_deposit_ts
        + 1;   // bump
}

#[account]
#[derive(Debug)]
pub struct FlashLoanReceipt {
    /// The pool being borrowed from
    pub pool: Pubkey,
    /// The borrower
    pub borrower: Pubkey,
    /// Amount borrowed
    pub amount: u64,
    /// Fee owed
    pub fee: u64,
    /// PDA bump
    pub bump: u8,
}

impl FlashLoanReceipt {
    pub const SIZE: usize = 8  // discriminator
        + 32   // pool
        + 32   // borrower
        + 8    // amount
        + 8    // fee
        + 1;   // bump
}
