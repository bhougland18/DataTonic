// "What should this be called?" — asked when saving a chart template.
//
// A dialog rather than `window.prompt`, and not for taste. **WebView2 does not
// implement `prompt`**, so on the desktop build the call returns immediately and
// the Template button would have done nothing at all — silently, with no error
// anywhere. The rest of this codebase already avoided it: every naming flow is
// an inline input or a modal, and `confirm` is the only native dialog used. That
// absence was the clue.
//
// Same shape as `UnsavedQueryDialog` — backdrop, title, body, right-aligned
// actions with the safe option first — and the same local classes, for the same
// reason recorded there.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from './backdrop';

export interface NameDialogProps {
    title: string;
    /** What the name is for, in a sentence. */
    body?: string;
    /** Pre-filled and pre-selected, so Enter accepts it. */
    initial?: string;
    label?: string;
    placeholder?: string;
    /** Said when the name is already taken, so "Save" reads as "replace". */
    takenLabel?: (name: string) => string | null;
    /**
     * Ask for a description too.
     *
     * Two fields rather than two dialogs, because the one place this is needed
     * — naming an unsaved query on the way to saving a dive — is a single
     * interruption and should stay one.
     */
    descriptionLabel?: string;
    initialDescription?: string;
    descriptionPlaceholder?: string;
    onSubmit: (name: string, description?: string) => void;
    onCancel: () => void;
}

export default function NameDialog({
    title,
    body,
    initial = '',
    label = 'Name',
    placeholder,
    takenLabel,
    descriptionLabel,
    initialDescription = '',
    descriptionPlaceholder,
    onSubmit,
    onCancel,
}: NameDialogProps) {
    const [value, setValue] = useState(initial);
    const [description, setDescription] = useState(initialDescription);
    const inputRef = useRef<HTMLInputElement>(null);

    // Focused AND selected: the suggested name is usually right, so Enter
    // should accept it and typing should replace it rather than append to it.
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const trimmed = value.trim();
    const taken = trimmed ? takenLabel?.(trimmed) : null;

    const submit = () => {
        if (trimmed) onSubmit(trimmed, descriptionLabel ? description.trim() : undefined);
    };

    // A press that began inside the dialog is not a click-away, however far
    // the mouse travelled before it was released.
    const backdrop = useBackdropDismiss(onCancel);

    return createPortal(
        <div className="blk-modal-backdrop" {...backdrop}>
            <div className="blk-modal" role="dialog" aria-modal="true">
                <div className="blk-modal-title">{title}</div>
                <div className="blk-modal-body">
                    {body ? <p className="blk-modal-p">{body}</p> : null}
                    <label className="blk-ced-field">
                        <span>{label}</span>
                        <input
                            ref={inputRef}
                            value={value}
                            placeholder={placeholder}
                            onChange={e => setValue(e.target.value)}
                            // Enter accepts, Escape cancels. A one-field dialog
                            // that needs the mouse is a dialog that annoys.
                            onKeyDown={e => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    submit();
                                } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    onCancel();
                                }
                            }}
                        />
                    </label>
                    {descriptionLabel ? (
                        <label className="blk-ced-field">
                            <span>{descriptionLabel}</span>
                            <input
                                value={description}
                                placeholder={descriptionPlaceholder}
                                onChange={e => setDescription(e.target.value)}
                                // Enter submits from here too: a two-field
                                // dialog where only the first field takes Enter
                                // is a dialog that feels broken.
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        submit();
                                    } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        onCancel();
                                    }
                                }}
                            />
                        </label>
                    ) : null}
                    {taken ? <p className="blk-modal-note">{taken}</p> : null}
                </div>
                <div className="blk-modal-actions">
                    <button type="button" className="erd-btn" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="erd-btn erd-btn--primary"
                        onClick={submit}
                        disabled={!trimmed}
                    >
                        {taken ? 'Replace' : 'Save'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
