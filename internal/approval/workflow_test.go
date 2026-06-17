package approval

import (
	"testing"

	"github.com/michongs/wayfort/internal/model"
)

func task(state model.ApprovalTaskState) model.ApprovalTask {
	return model.ApprovalTask{State: state}
}

func TestStageOutcome_Any(t *testing.T) {
	cases := []struct {
		name  string
		tasks []model.ApprovalTask
		want  StageOutcome
	}{
		{"first approval wins", []model.ApprovalTask{
			task(model.ApprovalTaskApproved),
			task(model.ApprovalTaskPending),
		}, StageApproved},
		{"single rejection with pending peer keeps running", []model.ApprovalTask{
			task(model.ApprovalTaskRejected),
			task(model.ApprovalTaskPending),
		}, StageStillRunning},
		{"all rejected fails", []model.ApprovalTask{
			task(model.ApprovalTaskRejected),
			task(model.ApprovalTaskRejected),
		}, StageRejected},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stageOutcomeFor(model.ApprovalStageAny, 0, tc.tasks); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestStageOutcome_All(t *testing.T) {
	cases := []struct {
		name  string
		tasks []model.ApprovalTask
		want  StageOutcome
	}{
		{"one rejection short-circuits", []model.ApprovalTask{
			task(model.ApprovalTaskApproved),
			task(model.ApprovalTaskRejected),
		}, StageRejected},
		{"all approved", []model.ApprovalTask{
			task(model.ApprovalTaskApproved),
			task(model.ApprovalTaskApproved),
		}, StageApproved},
		{"pending peer keeps running", []model.ApprovalTask{
			task(model.ApprovalTaskApproved),
			task(model.ApprovalTaskPending),
		}, StageStillRunning},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stageOutcomeFor(model.ApprovalStageAll, 0, tc.tasks); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestStageOutcome_Quorum(t *testing.T) {
	cases := []struct {
		name  string
		n     int
		tasks []model.ApprovalTask
		want  StageOutcome
	}{
		{"2 of 3 approved", 2, []model.ApprovalTask{
			task(model.ApprovalTaskApproved),
			task(model.ApprovalTaskApproved),
			task(model.ApprovalTaskPending),
		}, StageApproved},
		{"too many rejections to reach quorum", 2, []model.ApprovalTask{
			task(model.ApprovalTaskRejected),
			task(model.ApprovalTaskRejected),
			task(model.ApprovalTaskPending),
		}, StageRejected},
		{"still building toward quorum", 2, []model.ApprovalTask{
			task(model.ApprovalTaskApproved),
			task(model.ApprovalTaskPending),
			task(model.ApprovalTaskPending),
		}, StageStillRunning},
		{"zero quorum normalises to 1", 0, []model.ApprovalTask{
			task(model.ApprovalTaskApproved),
		}, StageApproved},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stageOutcomeFor(model.ApprovalStageQuorum, tc.n, tc.tasks); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestStageOutcome_SkippedCountsAsNeitherSide(t *testing.T) {
	tasks := []model.ApprovalTask{
		task(model.ApprovalTaskApproved),
		task(model.ApprovalTaskSkipped),
	}
	if got := stageOutcomeFor(model.ApprovalStageAll, 0, tasks); got != StageApproved {
		t.Fatalf("got %v, want StageApproved", got)
	}
}
