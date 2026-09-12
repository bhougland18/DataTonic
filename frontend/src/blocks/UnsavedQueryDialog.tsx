// "You have unsaved edits" — asked when leaving a query that has them.
//
// Three answers, not two, and the third is why this is a dialog rather than a
// confirm(): Cancel has to mean "I did not mean to leave", which OK/Cancel
// cannot say without conflating it with Discard. Getting that wrong costs
// somebody their query.
//
// Same shape as the Infor source's row-limit confirm (`pgi-modal-*` in
// `playground.css`) — backdrop, title, body, right-aligned actions with the
// safe option first and the primary last. The CLASSES are local rather than
// borrowed: Blocks depends on the SQL editor module and shares its styles
// deliberately, but it has no other tie to the playground, and one modal is a
// thin reason to grow one.

import { createPortal } from 'react-dom';

export interface UnsavedQueryDialogProps {
    /** The query being left, so the message can name it. */
    title: string;
    /** What happens once this is answered — "Starting a new query." etc. */
    nextLabel: string;
    /** Off when there is no title yet: nothing to save it under. */
    canSave: boolean;
    onSave: () => void;
    onDiscard: () => void;
    onCancel: () => void;
}

export default function UnsavedQueryDialog({
    title,
    nextLabel,
    canSave,
    onSave,
    onDiscard,
    onCancel,
}: UnsavedQueryDialogProps) {
    return createPortal(
        <div
            className="blk-modal-backdrop"
            // Clicking away is the ambiguous gesture, so it means Cancel — the
            // one answer that cannot lose anything.
            onClick={e => {
                if (e.target === e.currentTarget) onCancel();
            }}
        >
            <div className="blk-modal" role="dialog" aria-modal="true">
                <div className="blk-modal-title">Save your changes?</div>
                <div className="blk-modal-body">
                    {title ? (
                        <>
                            <b>{title}</b> has edits that are not saved.
                        </>
                    ) : (
                        'This query has not been saved yet.'
                    )}{' '}
                    {nextLabel}
                    {!canSave ? (
                        <>
                            <br />
                            Give it a title first if you want to keep it.
                        </>
                    ) : null}
                </div>
                <div className="blk-modal-actions">
                    <button type="button" className="erd-btn" onClick={onCancel}>
                        Cancel
                    </button>
                    <button type="button" className="erd-btn" onClick={onDiscard}>
                        Discard changes
                    </button>
                    <button
                        type="button"
                        className="erd-btn erd-btn--primary"
                        onClick={onSave}
                        disabled={!canSave}
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
