package tasks

import (
	"context"
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

type BridgeTask struct {
	UsdtTreasury    *contracts.UsdtTreasuryContract
	UsdtWallet      *contracts.UsdtWallet
	ExecutorWallet  *wallet.Wallet
	TreasuryData    *entity.UsdtTreasuryData
	MinBridgeAmount *big.Int
}

func NewBridgeTask() *BridgeTask {
	ctx := context.Background()

	cfg, err := config.Load()
	if err != nil {
		panic(err)
	}

	client := liteclient.NewConnectionPool()
	if err := client.AddConnectionsFromConfigFile(cfg.LiteServersConfig); err != nil {
		panic(err)
	}

	api := ton.NewAPIClient(client).WithRetry(5)

	words := strings.Split(cfg.WalletMnemonic, " ")
	wallet, err := wallet.FromSeed(api, words, wallet.V3R2)
	if err != nil {
		panic(err)
	}

	addr, err := address.ParseAddr(cfg.UsdtTreasuryAddress)
	if err != nil {
		panic(err)
	}
	usdtTreasury := contracts.NewUsdtTreasuryContract(api, "USDT_TREASURY", addr)

	usdtTreasuryData, err := usdtTreasury.GetData(ctx)
	if err != nil {
		panic(err)
	}

	addr, err = address.ParseAddr(cfg.UsdtWalletAddress)
	if err != nil {
		panic(err)
	}
	usdtWallet := contracts.NewUsdtWallet(api, "USDT_WALLET", addr)

	minBridgeAmount, _ := new(big.Int).SetString(cfg.MinBridgeAmount, 10)

	return &BridgeTask{
		UsdtTreasury:    usdtTreasury,
		UsdtWallet:      usdtWallet,
		ExecutorWallet:  wallet,
		TreasuryData:    usdtTreasuryData,
		MinBridgeAmount: minBridgeAmount,
	}
}

func (t *BridgeTask) Run(ctx context.Context) error {
	// Get the balance of the USDT wallet
	balance, err := t.UsdtWallet.GetBalance(ctx)
	if err != nil {
		return err
	}

	// Check if the balance is greater than the minimum bridge amount
	if balance.Cmp(t.MinBridgeAmount) < 0 {
		return nil
	}

	// Execute the bridge operation
	// err = t.UsdtTreasury.TriggerBridge(ctx, t.ExecutorWallet, balance, t.TreasuryData.GetTONValue())
	err = t.UsdtTreasury.TriggerBridge(ctx, t.ExecutorWallet, balance, t.TreasuryData.GetTONValue())

	return err
}
