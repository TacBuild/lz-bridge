# Cross Chain Layer

## Project structure

-   `contracts` - source code of all the smart contracts of the project and their dependencies. Currently implemented:

    - `CrossChainLayer` 
      - Main contract whose transactions are tracked by sequencers. It accepts messages from tvm and sends logs with data for evm. Receives messages from evm for executing on tvm. Stores merkel root from sequencers and collects user fees for them.

    - `JettonProxy` 
      - Contracts to accept and store any tokens when tvm=>evm. It redirects the message to CrossChainLayer. Also sends tokens from it when sending a message from evm to tvm.

    - `Executor` 
      - Contracts to process a message from evm to Stores a cell with the message to be executed in the TON. Also does not allow double sending of this message.

    - `Librarian` 
      - Contract is needed to store the code of some contracts as a library to reduce gas costs. For example, Order.

    - `Settings`
      - Contract that stores system configuration in a key-value format.

-   `wrappers` - wrapper classes (implementing `Contract` from ton-core) for the contracts, including any [de]serialization primitives and compilation functions.
-   `tests` - tests for the contracts.
-   `scripts` - scripts used by the project, mainly the deployment scripts.

## How to use

### Build

`npx blueprint build` or `yarn blueprint build`

### Test

`npx blueprint test` or `yarn blueprint test`

### Deploy or run another script

`npx blueprint run` or `yarn blueprint run`

### Add a new contract

`npx blueprint create ContractName` or `yarn blueprint create ContractName`
