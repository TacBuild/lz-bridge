package contracts

import (
	"fmt"

	"github.com/xssnick/tonutils-go/tlb"
)

const TVM_TX_STATUS_SUCCESS = 0

func CheckTVMTransactionSuccess(tx *tlb.Transaction) (err error) {
	if tx == nil {
		return fmt.Errorf("transaction is nil")
	}

	ordinaryTx, _ := tx.Description.(tlb.TransactionDescriptionOrdinary)

	switch phase := ordinaryTx.ComputePhase.Phase.(type) {
	case tlb.ComputePhaseVM:
		if phase.Details.ExitCode != TVM_TX_STATUS_SUCCESS {
			return fmt.Errorf("transaction failed with exit_code: %d", phase.Details.ExitCode)
		}
	case tlb.ComputePhaseSkipped:
		return fmt.Errorf("compute phase skipped due to: %s", phase.Reason.Type)
	}

	return nil
}
