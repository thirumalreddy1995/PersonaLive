import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
// Emscripten forwards the WASM runtime's C++ stderr to console.error. TensorFlow Lite / MediaPipe
// write informational start-up notices there (e.g. "INFO: Created TensorFlow Lite XNNPACK delegate
// for CPU."); re-route those to console.info so monitors do not report them as errors.
const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const isTFLiteInfo = args.some(
    (arg) =>
      typeof arg === 'string' &&
      (arg.startsWith('INFO:') || arg.includes('Created TensorFlow Lite') || arg.includes('XNNPACK delegate'))
  );
  if (isTFLiteInfo) {
    console.info(...args);
    return;
  }
  origConsoleError.apply(console, args);
};

createRoot(document.getElementById('root')!).render(<App />);
