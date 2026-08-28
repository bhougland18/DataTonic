import { LogIn, Server, Boxes, Info } from 'lucide-react';

// Infor provider panel — Phase A scaffold. The steps are laid out (sign in →
// environment → business class) so the flow is visible, but they are disabled
// placeholders: interactive webview auth (task 1i / DAA.32), the FSM
// environment selector (1l / DAA.35), and business-class discovery (1g/1h /
// DAA.30-31) land in the next phases. Until then, the Generic provider is the
// working path. Layout follows the approved mockup so this fills in place.
export default function InforProvider() {
    return (
        <div className="pg-infor">
            <div className="pg-infor-brand">
                <span className="pg-infor-mark" aria-hidden="true" />
                Infor · FSM / Landmark
            </div>

            <button type="button" className="pg-infor-step" disabled>
                <LogIn size={15} strokeWidth={1.75} />
                <span className="pg-infor-step-label">Sign in to Infor</span>
                <span className="pg-soon">soon</span>
            </button>

            <div className="pg-infor-step pg-infor-step--static">
                <Server size={15} strokeWidth={1.75} />
                <span className="pg-infor-step-label">Environment · Data Area</span>
                <span className="pg-soon">soon</span>
            </div>

            <div className="pg-infor-step pg-infor-step--static">
                <Boxes size={15} strokeWidth={1.75} />
                <span className="pg-infor-step-label">Business class</span>
                <span className="pg-soon">soon</span>
            </div>

            <div className="pg-infor-note">
                <Info size={14} strokeWidth={1.75} />
                <span>
                    Interactive login, the FSM environment picker, and business-class discovery
                    arrive next. For now, switch to <b>Generic</b> to import a spec by file or URL.
                </span>
            </div>
        </div>
    );
}
