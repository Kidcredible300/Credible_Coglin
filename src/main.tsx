import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import './index.css';
import { AppShell } from '@/components/AppShell';
import Dashboard from '@/routes/Dashboard';
import Boards from '@/routes/Boards';
import Roster from '@/routes/Roster';
import Outreach from '@/routes/Outreach';
import Placeholder from '@/routes/Placeholder';
import Debug from '@/routes/Debug';

// The theme is applied pre-paint by the inline script in index.html, so there
// is deliberately nothing to do here.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/boards" element={<Boards />} />
          <Route path="/outreach" element={<Outreach />} />
          <Route path="/roster" element={<Roster />} />
          <Route path="/awards" element={<Placeholder />} />
          <Route path="/portfolio" element={<Placeholder />} />
          <Route path="/calendar" element={<Placeholder />} />
          <Route path="/budget" element={<Placeholder />} />
          <Route path="/meetings" element={<Placeholder />} />
          <Route path="/debug" element={<Debug />} />
          {/* Any unknown path still renders the shell, which keeps the
              not_found_handling SPA-fallback check meaningful. */}
          <Route path="*" element={<Placeholder />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
