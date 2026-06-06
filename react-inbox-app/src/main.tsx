import ReactDOM from "react-dom/client";
import App from "./App";

// No StrictMode: its dev double-mount runs the auth effect twice
// (signIn -> signOut -> signIn), which churns the Courier shared client.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
