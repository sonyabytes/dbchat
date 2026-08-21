/** Registers a DOM (window/document/sessionStorage) before any test module is imported. */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
