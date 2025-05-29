package config

import (
	"fmt"

	"github.com/kelseyhightower/envconfig"
)

type Config struct {
	EthUsdtTreasuryAddress string `envconfig:"ETH_USDT_TREASURY_ADDRESS" required:"true"`
	TacUsdtTreasuryAddress string `envconfig:"TAC_USDT_TREASURY_ADDRESS" required:"true"`
	UsdtEthWalletAddress   string `envconfig:"USDT_ETH_WALLET_ADDRESS" required:"true"`
	UsdtTacWalletAddress   string `envconfig:"USDT_TAC_WALLET_ADDRESS" required:"true"`
	LiteServersConfig      string `envconfig:"LITE_SERVERS_CONFIG" required:"true"`
	WalletMnemonic         string `envconfig:"WALLET_MNEMONIC" required:"true"`

	MinBridgeAmount string `envconfig:"MIN_BRIDGE_AMOUNT" default:"100000000"`
}

func Load() (*Config, error) {
	var cfg Config
	err := envconfig.Process("", &cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}
	return &cfg, nil
}
