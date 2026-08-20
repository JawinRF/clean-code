import { useState } from 'react';

type ReadyResponse = {
  status: string
  database: string
  user: string
}

function App() {
  const [apiStatus, setApiStatus] = useState('Not checked');

  async function checkApi() {
    setApiStatus('Checking...');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
        controller.abort();
      },5000
    );
    try{
      const response = await fetch('/api/v1/ready',
        {
          signal: controller.signal,
        }
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = (await response.json()) as ReadyResponse;
      setApiStatus(
        `Database: ${data.database}, User: ${data.user}, Status: ${data.status}`
      );
    } catch (error) {
       const message = error instanceof DOMException
       && error.name=== 'AbortError'
          ? 'Request timed out'
          : error instanceof Error
            ? error.message
            : 'Unknown error'; 
      setApiStatus(`Connection failed: ${message}`);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  return (
    <>
      <h1>{apiStatus}</h1>

      <button type="button" onClick={checkApi}>
        Check system readiness
      </button>
    </>
  );
}

export default App;