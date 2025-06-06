package tasks

import (
	"context"
	"log"
	"math/big"
	"strings"

	"executor/config"
	"executor/contracts"
	"executor/entity"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/liteclient"
	"github.com/xssnick/tonutils-go/ton"
	"github.com/xssnick/tonutils-go/ton/wallet"
)

type BridgeToTacTask struct {
	UsdtTreasury    *contracts.TacUsdtTreasuryContract
	UsdtWallet      *contracts.UsdtWallet
	ExecutorWallet  *wallet.Wallet
	TreasuryData    *entity.TacUsdtTreasuryData
	MinBridgeAmount *big.Int
}

func NewBridgeToTacTask(cfg *config.Config) *BridgeToTacTask {
	ctx := context.Background()

	client := liteclient.NewConnectionPool()
	if err := client.AddConnectionsFromConfigFile(cfg.LiteServersConfig); err != nil {
		log.Fatalf("failed to create connection: %v", err)
	}

	api := ton.NewAPIClient(client).WithRetry(5)

	words := strings.Split(cfg.WalletMnemonic, " ")
	wallet, err := wallet.FromSeed(api, words, wallet.V3R2)
	if err != nil {
		log.Fatalf("failed to create wallet: %v", err)
	}

	addr, err := address.ParseAddr(cfg.TacUsdtTreasuryAddress)
	if err != nil {
		log.Fatalf("failed to parse tacUsdtTreasuryAddress address: %v", err)
	}
	usdtTreasury := contracts.NewTacUsdtTreasuryContract(api, "TAC_USDT_TREASURY", addr)

	usdtTreasuryData, err := usdtTreasury.GetData(ctx)
	if err != nil {
		log.Fatalf("failed to get data from tacUsdtTreasury: %v", err)
	}

	addr, err = address.ParseAddr(cfg.UsdtTacWalletAddress)
	if err != nil {
		log.Fatalf("failed to parse UsdtTacWalletAddress address: %v", err)
	}
	usdtWallet := contracts.NewUsdtWallet(api, "USDT_WALLET", addr)

	minBridgeAmount, _ := new(big.Int).SetString(cfg.MinBridgeAmount, 10)

	return &BridgeToTacTask{
		UsdtTreasury:    usdtTreasury,
		UsdtWallet:      usdtWallet,
		ExecutorWallet:  wallet,
		TreasuryData:    usdtTreasuryData,
		MinBridgeAmount: minBridgeAmount,
	}
}

func (t *BridgeToTacTask) Run(ctx context.Context) error {
	// Get the balance of the USDT wallet
	usdtBalance, err := t.UsdtWallet.GetBalance(ctx)
	if err != nil {
		return err
	}

	// Check if the balance is greater than the minimum bridge amount
	if usdtBalance.Cmp(t.MinBridgeAmount) < 0 {
		return nil
	}

	// Execute the bridge operation
	err = t.UsdtTreasury.TriggerBridge(ctx, t.ExecutorWallet, usdtBalance, t.TreasuryData.GetTONValue())

	return err
}
