import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router';
import './index.css';
import App from './App';
import Board from './routes/Board';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        {/* Deep-link route exists so Phase 0 verification can prove
            not_found_handling returns the SPA shell rather than a 404. */}
        <Route path="/board/:slug" element={<Board />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
