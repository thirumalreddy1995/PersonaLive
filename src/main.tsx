import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
// Filter benign TensorFlow Lite / MediaPipe WASM stderr messages forwarded by Emscripten to console.error
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
