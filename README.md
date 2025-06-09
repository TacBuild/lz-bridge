# LayerZero Bridge Integration  
### USDT Bridging from TON to EVM Chains (Ethereum and TAC)

## Overview

This document describes the integration of a cross-chain bridge that enables transferring USDT Jettons from the TON blockchain to EVM-compatible networks via LayerZero.  
The system consists of two main components:

- **Executor** – an off-chain service running on TON that monitors treasury balances and triggers bridge operations.
- **Treasury Contracts** – smart contracts deployed on TON, responsible for receiving Jettons and initiating LayerZero/TAC calls to EVM networks.

Two bridge directions are implemented:

- `TON → Ethereum`
- `TON → TAC`

---

## Bridge Flow: TON → Ethereum

### Process

1. A user sends Jetton USDT to the `eth_usdt_treasury` contract using a TON adapter from TAC.
2. The executor detects the balance change and initiates a LayerZero `OFTSend` message to the specified Ethereum address (e.g., a Veda pool).
3. Excess TON and Jettons (if any) are returned to the `eth_usdt_treasury` contract.
4. The executor can reuse this treasury balance for subsequent transactions, needing only to top up TON as gas.

### Design Considerations

- The contract defines fixed and deliberately high values for `native_fee`, `estimated_gas_cost`, and `jetton_transfer_gas_cost` to ensure that no funds get stuck in case of incorrect fee estimation.
- Executor can optionally include additional fee data via the `add_fee` field if they wish to increase gas or forwarding fees.

---

## Bridge Flow: TON → TAC

### Process

1. A user sends USDT Jettons to the `tac_usdt_treasury` contract from Ethereum using the LZ protocol.
2. The executor monitors this treasury contract and, upon detecting a balance change, triggers a transfer to TAC.
3. The payload includes:
   - **Fee data** (`fee_data`), specifying the TON amounts required for:
     - protocol operation,
     - TAC executor compensation,
     - TON executor gas,
     - and treasury margin.
   - **EVM data** (`evm_data`), which encodes the call to the TAC-side protocol:
     - the target address (e.g., a Veda pool) that should receive the funds,
     - and the list of valid executors permitted to execute the call.
4. The payload is constructed with `isRoundTrip = true`, allowing TAC to roll back the transaction in case of failure on the TAC side (though such failures are not expected).
5. All TON fees are fully consumed during execution — the contract does not rely on internal balance and requires full coverage of costs by the initiator.

### Design Considerations

- This direction supports an optional **gasless execution mode** if funds are sent to pre-approved pools like Veda.
- Users can attach extra TON in the `add_fee` field for higher-value transfers.
- Treasury fees ensure operational independence from contract balance and prevent disruptions.

---

### License

MIT