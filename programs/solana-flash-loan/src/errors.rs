use anchor_lang::prelude::*;

#[error_code]
pub enum FlashLoanError {
    #[msg("Invalid fee: must be between 0 and 10000 basis points")]
    InvalidFee,

    #[msg("Insufficient pool liquidity for flash loan")]
    InsufficientLiquidity,

    #[msg("Flash loan amount must be greater than zero")]
    InvalidAmount,

    #[msg("Pool is paused by admin")]
    PoolPaused,

    #[msg("Unauthorized: signer does not match expected authority")]
    Unauthorized,

    #[msg("Token mint does not match pool's token mint")]
    MintMismatch,

    #[msg("Vault account does not match pool's vault")]
    InvalidVault,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Insufficient shares for withdrawal")]
    InsufficientShares,

    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,

    #[msg("Withdraw amount must be greater than zero")]
    ZeroWithdraw,
}
