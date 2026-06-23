package dbstudio

import "testing"

// TestExportedSurface references every exported type, function, variable
// and method in the package so a rename/removal breaks compilation here
// rather than silently in a caller. It is the Task 2 surface-area guard
// pattern applied to dbstudio.
func TestExportedSurface(t *testing.T) {
	// Types — zero-value references prove the names exist.
	var _ ConnectionURI
	var _ Service
	var _ SavedQueriesStore
	var _ SavedQuery
	var _ PinnedResultsStore
	var _ PinnedResult
	var _ QueryHistoryStore
	var _ QueryHistoryEntry
	var _ ViewProfilesStore
	var _ ViewProfile
	var _ DataProfileStore
	var _ DataProfile
	var _ ColumnProfile
	var _ ERModelsStore
	var _ ERModel
	var _ ObjectApplier

	// Variables / constants.
	_ = ErrUnavailable

	// Functions (force evaluation).
	_, _ = ParseConnectionURI("mysql://u:p@h:1/d")

	// Service construction + accessors.
	s := NewService(nil, nil, nil)
	if s == nil {
		t.Fatal("NewService(nil,nil,nil) returned nil")
	}
	_ = s.SavedQueries()
	_ = s.PinnedResults()
	_ = s.QueryHistory()
	_ = s.ViewProfiles()
	_ = s.ERModels()
	_ = s.ObjectApplier()
	_ = s.Context(nil)
	if err := s.ensureDB(); err != ErrUnavailable {
		t.Fatalf("ensureDB on nil-db service: want ErrUnavailable, got %v", err)
	}
}

// TestStoresNilSafe guards the hard rule that EVERY store method MUST
// return ErrUnavailable (never panic) when its backing dependency is nil.
// It exercises one method per store against a NewService(nil,nil,nil).
func TestStoresNilSafe(t *testing.T) {
	s := NewService(nil, nil, nil)

	cases := []struct {
		name string
		fn   func() error
	}{
		{"SavedQueries.List", func() error { _, err := s.SavedQueries().List(nil, "o"); return err }},
		{"SavedQueries.Get", func() error { _, err := s.SavedQueries().Get(nil, 1); return err }},
		{"SavedQueries.Create", func() error { _, err := s.SavedQueries().Create(nil, SavedQuery{}); return err }},
		{"SavedQueries.Update", func() error { _, err := s.SavedQueries().Update(nil, SavedQuery{}); return err }},
		{"SavedQueries.Delete", func() error { return s.SavedQueries().Delete(nil, 1) }},

		{"PinnedResults.List", func() error { _, err := s.PinnedResults().List(nil, "o"); return err }},
		{"PinnedResults.Get", func() error { _, err := s.PinnedResults().Get(nil, 1); return err }},
		{"PinnedResults.Create", func() error { _, err := s.PinnedResults().Create(nil, PinnedResult{}); return err }},
		{"PinnedResults.Update", func() error { _, err := s.PinnedResults().Update(nil, PinnedResult{}); return err }},
		{"PinnedResults.Delete", func() error { return s.PinnedResults().Delete(nil, 1) }},

		{"QueryHistory.List", func() error { _, err := s.QueryHistory().List(nil, "o"); return err }},
		{"QueryHistory.Get", func() error { _, err := s.QueryHistory().Get(nil, 1); return err }},
		{"QueryHistory.Create", func() error { _, err := s.QueryHistory().Create(nil, QueryHistoryEntry{}); return err }},
		{"QueryHistory.Update", func() error { _, err := s.QueryHistory().Update(nil, QueryHistoryEntry{}); return err }},
		{"QueryHistory.Delete", func() error { return s.QueryHistory().Delete(nil, 1) }},

		{"ViewProfiles.List", func() error { _, err := s.ViewProfiles().List(nil, "o"); return err }},
		{"ViewProfiles.Get", func() error { _, err := s.ViewProfiles().Get(nil, 1); return err }},
		{"ViewProfiles.Create", func() error { _, err := s.ViewProfiles().Create(nil, ViewProfile{}); return err }},
		{"ViewProfiles.Update", func() error { _, err := s.ViewProfiles().Update(nil, ViewProfile{}); return err }},
		{"ViewProfiles.Delete", func() error { return s.ViewProfiles().Delete(nil, 1) }},

		{"ERModels.List", func() error { _, err := s.ERModels().List(nil, "o"); return err }},
		{"ERModels.Get", func() error { _, err := s.ERModels().Get(nil, 1); return err }},
		{"ERModels.Create", func() error { _, err := s.ERModels().Create(nil, ERModel{}); return err }},
		{"ERModels.Update", func() error { _, err := s.ERModels().Update(nil, ERModel{}); return err }},
		{"ERModels.Delete", func() error { return s.ERModels().Delete(nil, 1) }},

		{"ObjectApplier.Diff", func() error { _, err := s.ObjectApplier().Diff(nil, 1, nil, nil); return err }},
		{"ObjectApplier.Apply", func() error { return s.ObjectApplier().Apply(nil, 1, nil) }},
	}
	for _, c := range cases {
		if err := c.fn(); err != ErrUnavailable {
			t.Fatalf("%s on nil-dep service: want ErrUnavailable, got %v", c.name, err)
		}
	}

	// DataProfileStore is not wired into Service (no GORM layer of its own);
	// verify its standalone nil-safe path directly.
	dps := &DataProfileStore{}
	if _, err := dps.Profile(nil, 1, "s", "t"); err != ErrUnavailable {
		t.Fatalf("DataProfileStore.Profile on nil-dep: want ErrUnavailable, got %v", err)
	}
}
