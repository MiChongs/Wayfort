package designer

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

type damengDesigner struct{}

// NewDameng returns a Designer that renders Dameng/Oracle-flavored DDL.
// Phase 3B.1 ships Table; the rest return errNotYetImplemented.
func NewDameng() Designer { return &damengDesigner{} }

func (d *damengDesigner) RenderTable(ctx context.Context, spec TableSpec) (string, error) {
	if spec.Name == "" {
		return "", errors.New("designer: TableSpec.Name required")
	}
	lines := make([]string, 0, len(spec.Columns)+1)
	for _, c := range spec.Columns {
		var lb strings.Builder
		fmt.Fprintf(&lb, "  %s %s", dmIdent(strings.ToUpper(c.Name)), dmMapType(c.DataType))
		if !c.Nullable {
			lb.WriteString(" NOT NULL")
		}
		lines = append(lines, lb.String())
	}
	if len(spec.PrimaryKey) > 0 {
		upper := make([]string, len(spec.PrimaryKey))
		for i, k := range spec.PrimaryKey {
			upper[i] = strings.ToUpper(k)
		}
		lines = append(lines, fmt.Sprintf("  PRIMARY KEY (%s)", dmIdents(upper)))
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE %s (\n", dmQualify(spec.Schema, spec.Name))
	b.WriteString(strings.Join(lines, ",\n"))
	b.WriteString("\n)")
	return b.String(), nil
}

// ----- B2: View / Function / Procedure -----

func (d *damengDesigner) RenderView(ctx context.Context, s ViewSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: ViewSpec.Name required")
	}
	if s.Materialized {
		return "", errors.New("designer: Dameng materialized views require an explicit USING clause; use the SQL editor")
	}
	prefix := "CREATE"
	if s.OrReplace {
		prefix = "CREATE OR REPLACE"
	}
	return fmt.Sprintf("%s VIEW %s AS %s", prefix, dmQualify(s.Schema, s.Name), s.Definition), nil
}

func (d *damengDesigner) RenderFunction(ctx context.Context, s FunctionSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: FunctionSpec.Name required")
	}
	return fmt.Sprintf(`CREATE FUNCTION %s(%s)
RETURN %s
IS
BEGIN
  %s;
  RETURN NULL;
END;`, dmQualify(s.Schema, s.Name), dmArgs(s.Args), s.ReturnType, s.Body), nil
}

func (d *damengDesigner) RenderProcedure(ctx context.Context, s ProcedureSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: ProcedureSpec.Name required")
	}
	return fmt.Sprintf(`CREATE PROCEDURE %s(%s)
IS
BEGIN
  %s;
END;`, dmQualify(s.Schema, s.Name), dmArgs(s.Args), s.Body), nil
}

// ----- B3: Trigger / Event / Index / Sequence -----

func (d *damengDesigner) RenderTrigger(ctx context.Context, s TriggerSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: TriggerSpec.Name required")
	}
	if s.Table == "" {
		return "", errors.New("designer: TriggerSpec.Table required")
	}
	timing := s.Timing
	if timing == "" {
		timing = "BEFORE"
	}
	each := s.ForEach
	if each == "" {
		each = "ROW"
	}
	events := strings.Join(s.Events, " OR ")
	if events == "" {
		events = "INSERT"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TRIGGER %s %s %s ON %s\n", dmQualify(s.Schema, s.Name), timing, events, dmQualify(s.Schema, s.Table))
	fmt.Fprintf(&b, "FOR EACH %s\n", each)
	if s.When != "" {
		fmt.Fprintf(&b, "WHEN (%s)\n", s.When)
	}
	b.WriteString("BEGIN\n")
	fmt.Fprintf(&b, "  %s\n", s.Body)
	b.WriteString("END;")
	return b.String(), nil
}

func (d *damengDesigner) RenderEvent(ctx context.Context, s EventSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: EventSpec.Name required")
	}
	if s.Schedule == "" {
		return "", errors.New("designer: EventSpec.Schedule required")
	}
	jobName := strings.ToUpper(s.Name)
	if s.Schema != "" {
		jobName = strings.ToUpper(s.Schema) + "." + jobName
	}
	return fmt.Sprintf(`BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name => '%s',
    job_type => 'PLSQL_BLOCK',
    job_action => '%s',
    repeat_interval => '%s',
    enabled => TRUE
  );
END;`, dmEscape(jobName), dmEscape(s.Body), dmEscape(s.Schedule)), nil
}

func (d *damengDesigner) RenderIndex(ctx context.Context, s IndexSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: IndexSpec.Name required")
	}
	prefix := "CREATE"
	if s.Unique {
		prefix = "CREATE UNIQUE"
	}
	method := s.Method
	if method == "" {
		method = "BTREE"
	}
	upper := make([]string, len(s.Columns))
	for i, c := range s.Columns {
		upper[i] = strings.ToUpper(c)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s INDEX %s USING %s (%s)", prefix, dmIdent(strings.ToUpper(s.Name)), method, dmIdents(upper))
	if s.Where != "" {
		fmt.Fprintf(&b, " WHERE %s", s.Where)
	}
	return b.String(), nil
}

func (d *damengDesigner) RenderSequence(ctx context.Context, s SequenceSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: SequenceSpec.Name required")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE SEQUENCE %s", dmQualify(s.Schema, s.Name))
	if s.Start != 0 {
		fmt.Fprintf(&b, " START WITH %d", s.Start)
	}
	if s.Increment != 0 {
		fmt.Fprintf(&b, " INCREMENT BY %d", s.Increment)
	}
	if s.MinValue != nil {
		fmt.Fprintf(&b, " MINVALUE %d", *s.MinValue)
	}
	if s.MaxValue != nil {
		fmt.Fprintf(&b, " MAXVALUE %d", *s.MaxValue)
	}
	if s.Cache > 0 {
		fmt.Fprintf(&b, " CACHE %d", s.Cache)
	}
	if s.Cycle {
		b.WriteString(" CYCLE")
	} else {
		b.WriteString(" NOCYCLE")
	}
	return b.String(), nil
}

// dmArgs renders a Dameng/Oracle argument list as "NAME [MODE] TYPE" with
// upper-cased, double-quoted identifiers.
func dmArgs(args []ArgSpec) string {
	parts := make([]string, len(args))
	for i, a := range args {
		if a.Mode != "" {
			parts[i] = fmt.Sprintf("%s %s %s", dmIdent(strings.ToUpper(a.Name)), a.Mode, a.DataType)
		} else {
			parts[i] = fmt.Sprintf("%s %s", dmIdent(strings.ToUpper(a.Name)), a.DataType)
		}
	}
	return strings.Join(parts, ", ")
}

// dmEscape doubles single quotes for embedding inside a Dameng string literal.
func dmEscape(s string) string { return strings.ReplaceAll(s, "'", "''") }
func (d *damengDesigner) Diff(ctx context.Context, oldSpec, newSpec any) ([]Change, error) {
	return nil, errNotYetImplemented
}

// ----- helpers -----

// dmMapType maps generic SQL types to Dameng/Oracle equivalents.
func dmMapType(s string) string {
	switch strings.ToUpper(s) {
	case "BIGINT":
		return "NUMBER(19)"
	case "VARCHAR", "VARCHAR(255)":
		return "VARCHAR2(255)"
	case "TIMESTAMP":
		return "TIMESTAMP"
	case "INTEGER", "INT":
		return "NUMBER(10)"
	case "TEXT":
		return "CLOB"
	case "BYTEA", "BLOB":
		return "BLOB"
	}
	return s
}

func dmIdent(s string) string { return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\"" }

func dmIdents(ss []string) string {
	parts := make([]string, len(ss))
	for i, s := range ss {
		parts[i] = dmIdent(s)
	}
	return strings.Join(parts, ", ")
}

func dmQualify(schema, name string) string {
	if schema == "" {
		return dmIdent(strings.ToUpper(name))
	}
	return dmIdent(strings.ToUpper(schema)) + "." + dmIdent(strings.ToUpper(name))
}
