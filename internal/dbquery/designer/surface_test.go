package designer

import "testing"

func TestExportedSurface(t *testing.T) {
	var _ Designer
	var _ Change
	var _ ChangeOp
	var _ TableSpec
	var _ ColumnSpec
	var _ IndexSpec
	var _ ForeignKeySpec
	var _ ViewSpec
	var _ FunctionSpec
	var _ ProcedureSpec
	var _ ArgSpec
	var _ TriggerSpec
	var _ EventSpec
	var _ SequenceSpec
	_ = ChangeAdd
	_ = ChangeDrop
	_ = ChangeModify
}
