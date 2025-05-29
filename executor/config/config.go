package config

import (
	"fmt"

	"github.com/kelseyhightower/envconfig"
)

type Config struct {
	UsdtTreasuryAddress string `envconfig:"USDT_TREASURY_ADDRESS" required:"true"`
	UsdtWalletAddress   string `envconfig:"USDT_WALLET_ADDRESS" required:"true"`
	LiteServersConfig   string `envconfig:"LITE_SERVERS_CONFIG" required:"true"`
	WalletMnemonic      string `envconfig:"WALLET_MNEMONIC" required:"true"`

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
