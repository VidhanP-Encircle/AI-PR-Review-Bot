const API_BASE = process.env.NEXT_PUBLIC_API_URL 
  || (typeof window !== 'undefined' 
    ? `http://${window.location.hostname}:3001/api/v1` 
    : 'http://localhost:3001/api/v1');
export async function fetchWithAuth(endpoint: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> || {}),
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      // Redirect to login if unauthorized
      window.location.href = '/login';
    }
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `HTTP error! status: ${response.status}`);
  }

  return response.json();
}
