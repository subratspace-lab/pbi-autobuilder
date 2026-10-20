import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import './index.css';
import { Layout } from './components/Layout';
import { HomePage } from './pages/Home';
import { SettingsPage } from './pages/Settings';
import { UploadPage } from './pages/Upload';
import { ProfilePage } from './pages/Profile';
import { CleanPage } from './pages/Clean';
import { ModelPage } from './pages/Model';
import { MeasuresPage } from './pages/Measures';
import { DashboardPage } from './pages/Dashboard';
import { ExportPage } from './pages/Export';

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/p/:id', element: <Navigate to="upload" replace /> },
      { path: '/p/:id/upload', element: <UploadPage /> },
      { path: '/p/:id/profile', element: <ProfilePage /> },
      { path: '/p/:id/clean', element: <CleanPage /> },
      { path: '/p/:id/model', element: <ModelPage /> },
      { path: '/p/:id/measures', element: <MeasuresPage /> },
      { path: '/p/:id/dashboard', element: <DashboardPage /> },
      { path: '/p/:id/export', element: <ExportPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
