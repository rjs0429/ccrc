import { lazyScreen } from "../Boundary.tsx";

// The file viewer's code loads the first time a file opens.
export const FileViewer = lazyScreen(() => import("./FileViewer.tsx"));
