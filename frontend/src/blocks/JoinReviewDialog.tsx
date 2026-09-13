// "Your query now has a join — check what it keeps."
//
// Shown once, the first time a query grows a second table. The default is INNER,
// which drops rows that do not match on both sides — and that failure does not
// look like a failure. It looks like a smaller answer, which somebody reports.
//
// Worth one interruption for that reason, and dismissable for good because the
// person who already knows does not need telling twice. The preference is
// global rather than per-workspace: it is a fact about the reader, not the data.

import { createPortal } from 'react-dom';
import { useState } from 'react';
import { ArrowRight, Equal } from 'lucide-react';

export interface JoinReviewDialogProps {
    /** `remember` is true when the box was ticked. */
    onClose: (remember: boolean) => void;
}

export default function JoinReviewDialog({ onClose }: JoinReviewDialogProps) {
    const [remember, setRemember] = useState(false);

    return createPortal(
        <div
            className="blk-modal-backdrop"
            onClick={e => {
                if (e.target === e.currentTarget) onClose(remember);
            }}
        >
            <div className="blk-modal" role="dialog" aria-modal="true">
                <div className="blk-modal-title">Check how these tables are joined</div>
                <div className="blk-modal-body">
                    <p style={{ margin: '0 0 10px' }}>
                        Your query now spans more than one table, so the Joins section decides which
                        rows survive. It starts as an <b>inner</b> join, which is usually right and
                        is quietly wrong when it is not — you get fewer rows rather than an error.
                    </p>
                    <div className="blk-modal-legend">
                        <span>
                            <Equal size={13} strokeWidth={2.75} /> only rows matching on both sides
                        </span>
                        <span>
                            <ArrowRight size={13} strokeWidth={2.75} /> every row of one side,
                            matched or not
                        </span>
                    </div>
                    <p style={{ margin: '10px 0 0' }}>
                        Click the symbol between two table names to change it.
                    </p>
                </div>
                <div className="blk-modal-actions">
                    <label className="blk-modal-remember">
                        <input
                            type="checkbox"
                            checked={remember}
                            onChange={e => setRemember(e.target.checked)}
                        />
                        Don&rsquo;t show this again
                    </label>
                    <button
                        type="button"
                        className="erd-btn erd-btn--primary"
                        onClick={() => onClose(remember)}
                    >
                        Got it
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
