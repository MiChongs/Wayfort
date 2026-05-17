package log

import (
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func New(production bool) (*zap.Logger, error) {
	var cfg zap.Config
	if production {
		cfg = zap.NewProductionConfig()
	} else {
		cfg = zap.NewDevelopmentConfig()
		cfg.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
	}
	cfg.OutputPaths = []string{"stdout"}
	cfg.ErrorOutputPaths = []string{"stderr"}
	return cfg.Build()
}
