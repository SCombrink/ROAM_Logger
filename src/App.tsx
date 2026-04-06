import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import hatchLogo from "../hatch_logo.png";

interface Message {
  role: 'user' | 'ai';
  content: string;
}

export default function App() {
  const [status, setStatus] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [recognition, setRecognition] = useState<SpeechRecognition | null>(null);
  
  // Chat State
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // API Key State
  const [apiKey, setApiKey] = useState("");

  // Form State
  const [project] = useState("Hatch Global (Project View)");
  const [office] = useState("Johannesburg");
  const [address] = useState("58 Emerald Parkway Road, Greenstone Hill");
  const [exactLoc, setExactLoc] = useState("office");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  
  const [isContractor, setIsContractor] = useState(false);
  const [isWorkHours, setIsWorkHours] = useState(false);
  const [obsType, setObsType] = useState("Behaviour");
  const [obsSafe, setObsSafe] = useState("Safe");
  const [officeLoc, setOfficeLoc] = useState("Hatch office");
  
  const [details, setDetails] = useState("");
  const [action, setAction] = useState("");
  const [category] = useState("");
  const [cardType, setCardType] = useState("Field");

  const [isProjectLocked, setIsProjectLocked] = useState(false);
  const [isOfficeLocked, setIsOfficeLocked] = useState(false);
  const [isAddressLocked, setIsAddressLocked] = useState(false);

  // Dropdown state
  const [projectSearch, setProjectSearch] = useState("");
  const [officeSearch, setOfficeSearch] = useState("");
  const [addressSearch, setAddressSearch] = useState("");
  const [categorySearch, setCategorySearch] = useState("");

  const colors = {
    bg: "#FAFAFA", surface: "#F0F0F0", border: "#BFBFBF", text: "#2E2E2E", 
    text_muted: "#595959", primary: "#425563", primary_hover: "#2F3C46", 
    input_bg: "#FFFFFF", input_text: "#2E2E2E", orange: "#E84A37"
  };

  // Initialize speech recognition
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const recognitionInstance = new SpeechRecognition();
      recognitionInstance.continuous = true;
      recognitionInstance.interimResults = true;
      recognitionInstance.lang = 'en-US';

      recognitionInstance.onresult = (event: any) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript + ' ';
        }
        if (finalTranscript) setChatInput(prev => prev + finalTranscript);
      };
      setRecognition(recognitionInstance);
    }
  }, []);

  const handleSaveApiKey = async () => {
    try {
      const result = await invoke<string>("store_api_key", { key: apiKey });
      setStatus(result);
      setApiKey("");
    } catch (error) {
      setStatus(`Error saving key: ${error}`);
    }
  };

  const handleSendMessage = async () => {
    if (!chatInput.trim()) return;
    
    const userMsg = chatInput;
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setChatInput("");
    setIsAiLoading(true);

    try {
      const response = await invoke<string>("chat_with_ai", { prompt: userMsg });
      setMessages(prev => [...prev, { role: 'ai', content: response }]);
    } catch (error) {
      setMessages(prev => [...prev, { role: 'ai', content: `Error: ${error}` }]);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleStartRecording = () => {
    if (!recognition) return;
    if (isRecording) {
      recognition.stop();
      setIsRecording(false);
    } else {
      recognition.start();
      setIsRecording(true);
    }
  };

  const formatDateStr = (