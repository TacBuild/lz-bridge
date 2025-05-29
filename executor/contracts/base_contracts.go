package contracts

import (
	"context"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/ton"
)

type BaseContract struct {
	api     ton.APIClientWrapped
	name    string
	address *address.Address
}

func NewBaseContract(api ton.APIClientWrapped, name string, address *address.Address) *BaseContract {
	return &BaseContract{
		api:     api,
		name:    name,
		address: address,
	}
}

func (c *BaseContract) Name() string {
	return c.name
}

func (c *BaseContract) Address() *address.Address {
	return c.address
}

func (c *BaseContract) view(
	ctx context.Context,
	methodName string,
	params ...interface{},
) (*ton.ExecutionResult, error) {
	block, err := c.api.CurrentMasterchainInfo(ctx)
	if err != nil {
		return nil, err
	}

	res, err := c.api.WaitForBlock(block.SeqNo).RunGetMethod(ctx, block, c.address, methodName, params...)
	if err != nil {
		return nil, err
	}

	return res, nil
}
