package accesscontrol

import (
	"context"

	"github.com/michongs/wayfort/internal/approval"
	"github.com/michongs/wayfort/internal/model"
)

// ConnReviewAdapter adapts the rule Engine to approval.ConnReviewRules, letting
// the approval enforcement layer drive "is review required?" from
// asset_connection_review rules. Wired in the composition root via
// approval.Service.SetConnReviewRules.
//
// On any engine error or no-match it returns ConnReviewNone so enforcement falls
// back to the per-resource RequiresApproval* flags — additive and fail-safe. The
// Engine already fail-opens (returns accept/no-match) when the connection_review
// feature is unlicensed, so an unlicensed deployment is never blocked by rules.
type ConnReviewAdapter struct{ engine *Engine }

func NewConnReviewAdapter(e *Engine) *ConnReviewAdapter { return &ConnReviewAdapter{engine: e} }

func (a *ConnReviewAdapter) ConnectionReview(ctx context.Context, in approval.ConnReviewInput) approval.ConnReviewAction {
	if a == nil || a.engine == nil {
		return approval.ConnReviewNone
	}
	d, err := a.engine.Evaluate(ctx, model.RuleAssetConnectionReview, Input{
		UserID:       in.UserID,
		NodeID:       in.NodeID,
		CredentialID: in.CredentialID,
		ClientIP:     in.ClientIP,
	})
	if err != nil || !d.Matched {
		return approval.ConnReviewNone
	}
	switch d.Action {
	case model.ActionDeny:
		return approval.ConnReviewDeny
	case model.ActionReview:
		return approval.ConnReviewReview
	case model.ActionAccept:
		return approval.ConnReviewAccept
	case model.ActionNotify:
		return approval.ConnReviewNotify
	case model.ActionAlert:
		return approval.ConnReviewAlert
	}
	return approval.ConnReviewNone
}
