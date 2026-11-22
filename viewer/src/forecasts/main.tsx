import { createRoot } from "react-dom/client";
import "../styles.css";
import "./forecasts.css";
import { Page } from "./Page";

createRoot(document.getElementById("root")!).render(<Page />);
