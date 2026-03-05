# solana-flash-loan

Atomic flash loans on Solana. Borrow any amount, use it, repay with fee — all in one transaction or it reverts.

![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)
![Solana](https://img.shields.io/badge/Solana-9945FF?logo=solana&logoColor=white)
![Anchor](https://img.shields.io/badge/Anchor-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

## Features

- Atomic borrow-and-repay
- Configurable loan fees
- Multi-token support
- Pool liquidity management

## Program Instructions

`initialize` | `flash_loan` | `repay`

## Build

```bash
anchor build
```

## Test

```bash
anchor test
```

## Deploy

```bash
# Devnet
anchor deploy --provider.cluster devnet

# Mainnet
anchor deploy --provider.cluster mainnet
```

## Project Structure

```
programs/
  solana-flash-loan/
    src/
      lib.rs          # Program entry point and instructions
    Cargo.toml
tests/
  solana-flash-loan.ts           # Integration tests
Anchor.toml             # Anchor configuration
```

## License

MIT — see [LICENSE](LICENSE) for details.

## Author

Built by [Purple Squirrel Media](https://purplesquirrelmedia.io)
