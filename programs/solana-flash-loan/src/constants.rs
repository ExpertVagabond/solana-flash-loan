pub const LENDING_POOL_SEED: &[u8] = b"lending_pool";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const DEPOSIT_RECEIPT_SEED: &[u8] = b"deposit_receipt";
pub const FLASH_LOAN_RECEIPT_SEED: &[u8] = b"flash_loan_receipt";

/// Default fee: 9 basis points = 0.09% (Aave-equivalent)
pub const DEFAULT_FEE_BASIS_POINTS: u16 = 9;

/// Maximum allowed fee: 100% (10000 basis points)
pub const MAX_FEE_BASIS_POINTS: u16 = 10_000;
