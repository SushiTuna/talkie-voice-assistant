// Single entry for the project's Lion-based components. Importing this file registers every
// `tour-*` custom element plus `lion-form`, and loads Lion's default validation feedback
// messages. Setup only: no markup uses these tags yet.
import "@lion/ui/define/lion-form.js";
import { loadDefaultFeedbackMessages } from "@lion/ui/validate-messages.js";

import "./tour-radio.js";
import "./tour-input.js";
import "./tour-button.js";
import "./tour-switch.js";
import "./tour-collapsible.js";

loadDefaultFeedbackMessages();
