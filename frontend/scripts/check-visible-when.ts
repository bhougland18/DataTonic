// Every `visibleWhen` condition must be satisfiable.
//
// A field gated on a value its controlling dropdown cannot produce is invisible
// forever. Nothing reports it: the form renders, the engine still reads the
// property, and the only symptom is a setting nobody can reach. That is the
// same silent-dead-control shape this repository keeps finding, one level
// further in - the control is not dead, the *route to it* is.
//
// Two ways to get there, both checked:
//
//   1. A non-string in `equals`. The evaluator compares `String(value)`, so
//      `equals: [false]` never matches - `[false].includes('false')` is false.
//      Written while adding a bool-gated field, caught before it shipped, and
//      the reason this check exists.
//   2. A value the controlling field does not offer.
//
// Run via scripts/check-visible-when.mjs, which bundles this with esbuild and
// stubs the Tauri bridge so it runs under plain Node - the same arrangement
// export-catalog.ts uses.

import { getManifest } from '../src/workflow-ui/fields/component-manifests';
import { PALETTE } from '../src/workflow-ui/palette-data';

const components = [];
for (const category of PALETTE) {
    for (const group of category.groups) components.push(...group.components);
}

const problems = [];
let conditions = 0;

for (const component of components) {
    let manifest;
    try {
        manifest = getManifest(component.id);
    } catch {
        continue; // A component with no form is a different check's business.
    }
    if (!manifest?.sections) continue;

    const byKey = new Map();
    for (const section of manifest.sections) {
        for (const field of section.fields) byKey.set(field.key, field);
    }

    for (const section of manifest.sections) {
        for (const field of section.fields) {
            if (!field.visibleWhen) continue;
            const conds = Array.isArray(field.visibleWhen)
                ? field.visibleWhen
                : [field.visibleWhen];

            for (const cond of conds) {
                conditions++;
                const where = `${component.id}.${field.key}`;

                if (!byKey.has(cond.key)) {
                    problems.push(
                        `${where}: gated on '${cond.key}', which this form has no field for`,
                    );
                    continue;
                }
                if (cond.equals === undefined) continue;

                const wanted = Array.isArray(cond.equals) ? cond.equals : [cond.equals];
                const nonString = wanted.filter(v => typeof v !== 'string');
                if (nonString.length) {
                    problems.push(
                        `${where}: equals contains ${JSON.stringify(nonString)}; the ` +
                            `evaluator compares String(value), so only strings can match ` +
                            `(use '${String(nonString[0])}')`,
                    );
                    continue;
                }

                // Only a closed value set can be checked. A typable select or a
                // free-text control can hold anything.
                const ctrl = byKey.get(cond.key);
                if (ctrl.allowCustom) continue;
                let allowed = null;
                if (ctrl.options?.length) allowed = ctrl.options.map(o => String(o.value));
                else if (ctrl.kind === 'bool') allowed = ['true', 'false', 'undefined'];
                if (!allowed) continue;

                const impossible = wanted.map(String).filter(w => !allowed.includes(w));
                if (impossible.length) {
                    problems.push(
                        `${where}: waits for ${cond.key}=${JSON.stringify(impossible)}, but ` +
                            `${cond.key} can only be ${JSON.stringify(allowed)} - the field ` +
                            `can never be shown`,
                    );
                }
            }
        }
    }
}

console.log(
    `check-visible-when: ${conditions} conditions across ${components.length} components`,
);
if (problems.length) {
    console.error(`\n${problems.length} unsatisfiable condition(s):\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
        '\nA field behind one of these can never be shown. Either offer the value ' +
            'on the controlling field, or omit the field rather than gating it on ' +
            'something impossible.',
    );
    process.exit(1);
}
console.log('every condition is satisfiable');
