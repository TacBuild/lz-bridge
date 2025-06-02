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

type BridgeToEthTask struct {
	UsdtTreasury    *contracts.EthUsdtTreasuryContract
	UsdtWallet      *contracts.UsdtWallet
	ExecutorWallet  *wallet.Wallet
	TreasuryData    *entity.EthUsdtTreasuryData
	MinBridgeAmount *big.Int
}

func NewBridgeToEthTask() *BridgeToEthTask {
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

	addr, err := address.ParseAddr(cfg.EthUsdtTreasuryAddress)
	if err != nil {
		panic(err)
	}
	usdtTreasury := contracts.NewEthUsdtTreasuryContract(api, "ETH_USDT_TREASURY", addr)

	usdtTreasuryData, err := usdtTreasury.GetData(ctx)
	if err != nil {
		panic(err)
	}

	addr, err = address.ParseAddr(cfg.UsdtEthWalletAddress)
	if err != nil {
		panic(err)
	}
	usdtWallet := contracts.NewUsdtWallet(api, "USDT_WALLET", addr)

	minBridgeAmount, _ := new(big.Int).SetString(cfg.MinBridgeAmount, 10)

	return &BridgeToEthTask{
		UsdtTreasury:    usdtTreasury,
		UsdtWallet:      usdtWallet,
		ExecutorWallet:  wallet,
		TreasuryData:    usdtTreasuryData,
		MinBridgeAmount: minBridgeAmount,
	}
}

func (t *BridgeToEthTask) Run(ctx context.Context) error {
	// Get the balance of the USDT wallet
	usdtBalance, err := t.UsdtWallet.GetBalance(ctx)
	if err != nil {
		return err
	}

	if usdtBalance.Cmp(t.MinBridgeAmount) < 0 {
		return nil
	}

	if usdtBalance.Cmp(t.TreasuryData.MaxBridgeAmount) >= 1 {
		usdtBalance = t.TreasuryData.MaxBridgeAmount
	}

	tonBalance, err := t.UsdtTreasury.GetBalance(ctx)
	if err != nil {
		return err
	}

	neededValue := t.TreasuryData.GetTONValue()
	neededValue.Sub(neededValue, tonBalance)

	minValue := t.TreasuryData.GetMinTonValue()
	if neededValue.Cmp(minValue) < 0 {
		neededValue = minValue
	}
	// for storage in case
	neededValue.Add(neededValue, big.NewInt(5000000))

	err = t.UsdtTreasury.TriggerBridge(ctx, t.ExecutorWallet, usdtBalance, neededValue)

	return err
}
