import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ClockProvider } from "./useNow";
import "./App.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* One clock for the whole tree: a single interval regardless of how
		    many countdowns are on screen, corrected against the server. */}
		<ClockProvider>
			<App />
		</ClockProvider>
	</StrictMode>,
);
