// src/hooks/useWebSocket.ts
export function useWebSocket(url: string) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);
  
  useEffect(() => {
    const ws = new WebSocket(url);
    
    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setLastMessage(data);
      
      // Show toast for important updates
      if (data.type === 'notification') {
        toast(data.message);
      }
    };
    
    return () => ws.close();
  }, [url]);
  
  return { isConnected, lastMessage };
}