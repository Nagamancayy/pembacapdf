import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import { 
  Volume2, Play, Pause, Square, FileText, Upload, SkipForward, SkipBack, 
  Languages, Sliders, BookOpen, CheckCircle, AlertCircle, RefreshCw, History, Trash2, Download
} from 'lucide-react';

// Setup pdfjs worker using Vite asset URL resolving
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// --- IndexedDB Local Storage Helpers ---
const DB_NAME = 'DocuVoiceDB';
const STORE_NAME = 'documents';

const openDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
};

const saveDocumentToDB = async (name, type, arrayBuffer) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const data = {
      name,
      type,
      fileData: arrayBuffer,
      timestamp: Date.now()
    };
    const request = store.add(data);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const getDocumentsFromDB = async () => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const docs = request.result.map(d => ({
        id: d.id,
        name: d.name,
        type: d.type,
        timestamp: d.timestamp
      })).sort((a, b) => b.timestamp - a.timestamp);
      resolve(docs);
    };
    request.onerror = () => reject(request.error);
  });
};

const getDocumentFileFromDB = async (id) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const deleteDocumentFromDB = async (id) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export default function App() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Document state
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [docxHtml, setDocxHtml] = useState(''); 
  
  // Text & mapping states (word-level granularity)
  const [textItems, setTextItems] = useState([]); // Array of { text, pageNum, rect, start, end }
  const [currentItemIndex, setCurrentItemIndex] = useState(-1);
  
  // Local History States
  const [historyList, setHistoryList] = useState([]);
  const [saveToHistory, setSaveToHistory] = useState(true);

  // TTS State
  const [voices, setVoices] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [languageFilter, setLanguageFilter] = useState('all');
  const [rate, setRate] = useState(1.0);
  const [pitch, setPitch] = useState(1.0);
  const [volume, setVolume] = useState(1.0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  
  // Local Tab Recording States
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const screenStreamRef = useRef(null);
  const speechTimerRef = useRef(null);

  const synthRef = useRef(window.speechSynthesis);
  const utteranceRef = useRef(null);
  const utteranceItemsRef = useRef([]); // maps word boundary charIndex to textItems index
  const canvasRefs = useRef({});
  const containerRef = useRef(null);

  // Load available voices and history list
  useEffect(() => {
    const loadVoices = () => {
      if (synthRef.current) {
        const availableVoices = synthRef.current.getVoices();
        setVoices(availableVoices);
        
        if (availableVoices.length > 0) {
          const indVoices = availableVoices.filter(v => v.lang.startsWith('id') || v.lang.startsWith('in'));
          const googleInd = indVoices.find(v => 
            v.name.toLowerCase().includes('online') ||
            v.name.toLowerCase().includes('google') || 
            v.name.toLowerCase().includes('microsoft') ||
            v.name.toLowerCase().includes('natural')
          );
          const normalInd = indVoices[0];
          const engVoices = availableVoices.filter(v => v.lang.startsWith('en'));
          const googleEng = engVoices.find(v => 
            v.name.toLowerCase().includes('online') ||
            v.name.toLowerCase().includes('google') || 
            v.name.toLowerCase().includes('microsoft') ||
            v.name.toLowerCase().includes('natural')
          );
          
          if (googleInd) {
            setSelectedVoice(googleInd.name);
          } else if (normalInd) {
            setSelectedVoice(normalInd.name);
          } else if (googleEng) {
            setSelectedVoice(googleEng.name);
          } else if (engVoices.length > 0) {
            setSelectedVoice(engVoices[0].name);
          } else {
            setSelectedVoice(availableVoices[0].name);
          }
        }
      }
    };

    loadVoices();
    if (synthRef.current) {
      synthRef.current.onvoiceschanged = loadVoices;
    }
    
    // Load local history list
    loadHistoryList();

    return () => {
      if (synthRef.current) {
        synthRef.current.cancel();
      }
    };
  }, []);

  const loadHistoryList = async () => {
    try {
      const list = await getDocumentsFromDB();
      setHistoryList(list);
    } catch (err) {
      console.error('Failed to load history list', err);
    }
  };

  // Sync scroll view based on active word item
  useEffect(() => {
    if (currentItemIndex >= 0 && textItems[currentItemIndex]) {
      const activeItem = textItems[currentItemIndex];
      const pageEl = document.getElementById(`page-container-${activeItem.pageNum}`);
      
      if (pageEl && containerRef.current) {
        const rect = pageEl.getBoundingClientRect();
        const containerRect = containerRef.current.getBoundingClientRect();
        
        const isOutOfView = rect.top < containerRect.top || rect.bottom > containerRect.bottom;
        if (isOutOfView) {
          pageEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }
  }, [currentItemIndex, textItems]);

  // Render PDF pages on canvas
  const renderPdfPage = async (pageNumber, pdfInstance) => {
    const canvas = canvasRefs.current[pageNumber];
    if (!canvas || !pdfInstance) return;

    try {
      const page = await pdfInstance.getPage(pageNumber);
      const context = canvas.getContext('2d');
      
      const containerWidth = canvas.parentElement.clientWidth || 800;
      const viewport = page.getViewport({ scale: 1.0 });
      const scale = containerWidth / viewport.width;
      const scaledViewport = page.getViewport({ scale: scale });

      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;

      const renderContext = {
        canvasContext: context,
        viewport: scaledViewport
      };
      await page.render(renderContext).promise;
    } catch (err) {
      console.error('Error rendering page:', err);
    }
  };

  // Process Document (accepts ArrayBuffer directly if loaded from DB)
  const processFile = async (uploadedFile, shouldSaveToDB = true) => {
    setLoading(true);
    setError('');
    setFile(uploadedFile);
    setPdfDoc(null);
    setNumPages(0);
    setDocxHtml('');
    setCurrentItemIndex(-1);
    stopReading();

    const extension = uploadedFile.name.split('.').pop().toLowerCase();
    const reader = new FileReader();

    try {
      if (extension === 'pdf') {
        reader.onload = async (e) => {
          try {
            const arrayBuffer = e.target.result;
            const typedarray = new Uint8Array(arrayBuffer);
            
            // Save to IndexedDB local storage if enabled
            if (shouldSaveToDB && saveToHistory) {
              await saveDocumentToDB(uploadedFile.name, 'pdf', arrayBuffer);
              loadHistoryList();
            }

            const pdf = await pdfjsLib.getDocument({ data: typedarray }).promise;
            setPdfDoc(pdf);
            setNumPages(pdf.numPages);

            let fullText = '';
            const items = [];

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
              const page = await pdf.getPage(pageNum);
              const textContent = await page.getTextContent();
              const viewport = page.getViewport({ scale: 1.0 });

              for (const item of textContent.items) {
                if (!item.str.trim()) continue;
                
                const rect = viewport.convertToViewportRectangle([
                  item.transform[4],
                  item.transform[5],
                  item.transform[4] + item.width,
                  item.transform[5] + item.height
                ]);

                const x = Math.min(rect[0], rect[2]);
                const y = Math.min(rect[1], rect[3]);
                const w = Math.abs(rect[2] - rect[0]);
                const h = Math.abs(rect[3] - rect[1]);

                const wordsAndSpaces = item.str.split(/(\s+)/);
                const totalChars = item.str.length || 1;
                let currentX = x;

                for (const part of wordsAndSpaces) {
                  const partW = (part.length / totalChars) * w;
                  if (part.trim().length > 0) {
                    const startIdx = fullText.length;
                    fullText += part;
                    const endIdx = fullText.length;

                    items.push({
                      text: part,
                      pageNum,
                      rect: { x: currentX, y, w: partW, h, pageW: viewport.width, pageH: viewport.height },
                      start: startIdx,
                      end: endIdx
                    });
                  } else {
                    fullText += part;
                  }
                  currentX += partW;
                }
                fullText += ' ';
              }
              fullText += '\n';
            }

            setTextItems(items);
            setLoading(false);
          } catch (err) {
            console.error(err);
            setError('Gagal memproses dokumen PDF.');
            setLoading(false);
          }
        };
        
        if (uploadedFile.dbBuffer) {
          const fakeEvent = { target: { result: uploadedFile.dbBuffer } };
          reader.onload(fakeEvent);
        } else {
          reader.readAsArrayBuffer(uploadedFile);
        }

      } else if (extension === 'docx') {
        reader.onload = async (e) => {
          try {
            const arrayBuffer = e.target.result;
            
            // Save to IndexedDB local storage if enabled
            if (shouldSaveToDB && saveToHistory) {
              await saveDocumentToDB(uploadedFile.name, 'docx', arrayBuffer);
              loadHistoryList();
            }

            const textResult = await mammoth.extractRawText({ arrayBuffer });
            const rawWords = textResult.value.split(/\s+/).filter(w => w.length > 0);
            
            let offset = 0;
            const items = rawWords.map((word) => {
              const start = offset;
              const end = offset + word.length;
              offset += word.length + 1;
              return {
                text: word,
                pageNum: 1,
                rect: null,
                start,
                end
              };
            });

            setTextItems(items);

            const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
            setDocxHtml(htmlResult.value);
            setLoading(false);
          } catch (err) {
            console.error(err);
            setError('Gagal memproses dokumen DOCX.');
            setLoading(false);
          }
        };
        
        if (uploadedFile.dbBuffer) {
          const fakeEvent = { target: { result: uploadedFile.dbBuffer } };
          reader.onload(fakeEvent);
        } else {
          reader.readAsArrayBuffer(uploadedFile);
        }
      } else {
        setError('Format file tidak didukung. Silakan gunakan PDF atau DOCX.');
        setLoading(false);
      }
    } catch (err) {
      console.error(err);
      setError('Terjadi kesalahan.');
      setLoading(false);
    }
  };

  // Load document from local History
  const loadHistoryItem = async (historyItem) => {
    try {
      setLoading(true);
      const fullDoc = await getDocumentFileFromDB(historyItem.id);
      if (fullDoc && fullDoc.fileData) {
        const pseudoFile = {
          name: fullDoc.name,
          dbBuffer: fullDoc.fileData
        };
        await processFile(pseudoFile, false); 
      }
    } catch (err) {
      console.error('Failed to load history item', err);
      setError('Gagal memuat dokumen dari riwayat lokal.');
      setLoading(false);
    }
  };

  // Delete document from local History
  const deleteHistoryItem = async (e, id) => {
    e.stopPropagation(); 
    if (confirm('Hapus dokumen ini dari riwayat browser Anda?')) {
      try {
        await deleteDocumentFromDB(id);
        loadHistoryList();
        
        if (file && file.id === id) {
          setFile(null);
          setPdfDoc(null);
          setNumPages(0);
          setDocxHtml('');
          setTextItems([]);
          setCurrentItemIndex(-1);
          stopReading();
        }
      } catch (err) {
        console.error('Failed to delete history item', err);
      }
    }
  };

  // Trigger page render for all pages sequentially once loaded
  useEffect(() => {
    if (pdfDoc && numPages > 0) {
      const renderAll = async () => {
        for (let i = 1; i <= numPages; i++) {
          await renderPdfPage(i, pdfDoc);
        }
      };
      setTimeout(renderAll, 100);
    }
  }, [numPages, pdfDoc]);

  // Audio / TTS Logic
  const startReading = (index = 0) => {
    if (!synthRef.current || textItems.length === 0) return;
    
    synthRef.current.cancel();
    
    if (index < 0 || index >= textItems.length) {
      setIsPlaying(false);
      setIsPaused(false);
      setCurrentItemIndex(-1);
      
      // Auto-stop recording if it reaches the end
      if (isRecording && mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    setCurrentItemIndex(index);
    setIsPlaying(true);
    setIsPaused(false);

    // Read in chunks of 40 words to prevent browser speech synthesis overload/limits
    const chunkSize = 40;
    const endIndex = Math.min(index + chunkSize, textItems.length);
    const chunkItems = textItems.slice(index, endIndex);
    
    let currentOffset = 0;
    const utteranceItems = [];
    const remainingTextParts = [];

    for (let i = 0; i < chunkItems.length; i++) {
      const item = chunkItems[i];
      remainingTextParts.push(item.text);
      utteranceItems.push({
        originalIndex: index + i,
        start: currentOffset,
        end: currentOffset + item.text.length
      });
      currentOffset += item.text.length + 1;
    }

    utteranceItemsRef.current = utteranceItems;
    const textToSpeak = remainingTextParts.join(' ');
    
    if (!textToSpeak.trim()) {
      if (endIndex < textItems.length) {
        startReading(endIndex);
      } else {
        setIsPlaying(false);
        setIsPaused(false);
        setCurrentItemIndex(-1);
        if (isRecording && mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      }
      return;
    }

    // Clear any existing backup timer
    if (speechTimerRef.current) {
      clearInterval(speechTimerRef.current);
      speechTimerRef.current = null;
    }

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utteranceRef.current = utterance;

    const voice = voices.find(v => v.name === selectedVoice);
    if (voice) utterance.voice = voice;
    
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.volume = volume;

    // Estimate speaking rate: ~150 words per minute at 1.0 rate.
    // Set a timer interval to advance the highlight if the online voice does not trigger boundaries.
    const wordsPerMinute = 150 * rate;
    const msPerWord = (60 / wordsPerMinute) * 1000;
    let simulatedIndex = index;

    speechTimerRef.current = setInterval(() => {
      simulatedIndex++;
      if (simulatedIndex < endIndex) {
        setCurrentItemIndex(simulatedIndex);
      } else {
        clearInterval(speechTimerRef.current);
      }
    }, msPerWord);

    utterance.onboundary = (event) => {
      if (event.name === 'word') {
        const charIndex = event.charIndex;
        // Search for the closest preceding word
        let activeUtteranceItem = null;
        for (const it of utteranceItemsRef.current) {
          if (charIndex >= it.start) {
            activeUtteranceItem = it;
          } else {
            break;
          }
        }
        if (activeUtteranceItem) {
          const matchedIndex = activeUtteranceItem.originalIndex;
          setCurrentItemIndex(matchedIndex);
          simulatedIndex = matchedIndex; // Keep fallback timer in sync
        }
      }
    };

    utterance.onend = () => {
      if (speechTimerRef.current) {
        clearInterval(speechTimerRef.current);
        speechTimerRef.current = null;
      }
      if (endIndex < textItems.length) {
        startReading(endIndex);
      } else {
        setIsPlaying(false);
        setIsPaused(false);
        setCurrentItemIndex(-1);
        
        // Auto-stop recording if it reaches the end
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      }
    };

    utterance.onerror = (e) => {
      console.error('TTS error:', e);
      if (speechTimerRef.current) {
        clearInterval(speechTimerRef.current);
        speechTimerRef.current = null;
      }
      if (e.error !== 'interrupted') {
        setIsPlaying(false);
        setIsPaused(false);
        if (isRecording && mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      }
    };

    synthRef.current.speak(utterance);
  };

  const pauseReading = () => {
    if (synthRef.current && isPlaying && !isPaused) {
      synthRef.current.pause();
      setIsPaused(true);
    }
    if (speechTimerRef.current) {
      clearInterval(speechTimerRef.current);
      speechTimerRef.current = null;
    }
  };

  const resumeReading = () => {
    if (synthRef.current && isPlaying && isPaused) {
      synthRef.current.resume();
      setIsPaused(false);
      // Restart WPM timer on resume from the current word position
      startReading(currentItemIndex >= 0 ? currentItemIndex : 0);
    } else if (textItems.length > 0) {
      startReading(currentItemIndex >= 0 ? currentItemIndex : 0);
    }
  };

  const stopReading = () => {
    if (synthRef.current) {
      synthRef.current.cancel();
      setIsPlaying(false);
      setIsPaused(false);
      setCurrentItemIndex(-1);
    }
    if (speechTimerRef.current) {
      clearInterval(speechTimerRef.current);
      speechTimerRef.current = null;
    }
    if (isRecording && mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const nextItem = () => {
    if (textItems.length === 0) return;
    const nextIdx = currentItemIndex + 1;
    if (nextIdx < textItems.length) startReading(nextIdx);
  };

  const prevItem = () => {
    if (textItems.length === 0) return;
    const prevIdx = currentItemIndex - 1;
    if (prevIdx >= 0) startReading(prevIdx);
  };

  // --- Local Tab Audio Recording Handlers ---
  const startRecordingAudio = async () => {
    try {
      alert(
        'Petunjuk Perekaman Audio Lokal:\n\n' +
        '1. Browser akan meminta izin membagikan layar/tab ("Share your screen/tab").\n' +
        '2. Silakan pilih "Tab ini" (This tab).\n' +
        '3. PASTIKAN mencentang pilihan "Bagikan audio tab" (Share tab audio).\n' +
        '4. Klik Share/Bagikan untuk mulai merekam otomatis.'
      );

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: 1,
          height: 1
        },
        audio: true
      });
      
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach(t => t.stop());
        alert('Gagal merekam: Anda harus mencentang opsi "Bagikan audio tab" agar audio dapat direkam.');
        return;
      }

      screenStreamRef.current = stream;
      audioChunksRef.current = [];
      setIsRecording(true);

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(audioBlob);
        const a = document.createElement('a');
        a.href = url;
        const baseName = file ? file.name.split('.')[0] : 'audio';
        a.download = `${baseName}_DocuVoice.webm`;
        a.click();
        URL.revokeObjectURL(url);
        
        // Cleanup streams
        stream.getTracks().forEach(t => t.stop());
        setIsRecording(false);
      };

      recorder.start();
      
      // Start reading from the very beginning
      startReading(0);

    } catch (err) {
      console.error('Error starting recording:', err);
      setIsRecording(false);
    }
  };

  const stopRecordingAudio = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  // Drag & drop handlers
  const [dragActive, setDragActive] = useState(false);
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };
  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      await processFile(e.dataTransfer.files[0]);
    }
  };

  const languagesList = Array.from(new Set(voices.map(v => v.lang.split('-')[0]))).sort();
  const filteredVoices = voices.filter(v => languageFilter === 'all' || v.lang.startsWith(languageFilter));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', maxHeight: '100vh', overflow: 'hidden' }}>
      
      {/* Header */}
      <header className="glass-panel" style={{ margin: '16px', padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)', padding: '8px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Volume2 size={20} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: '20px' }}>DocuVoice</h1>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Mulai membaca tepat dari kata yang Anda klik secara interaktif</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-muted)' }}>
          <CheckCircle size={14} color="var(--accent-success)" />
          <span>Keamanan Terjamin (100% Client-Side)</span>
        </div>
      </header>

      {/* Main workspace */}
      <main style={{ flex: 1, display: 'grid', gridTemplateColumns: '320px 1fr', gap: '16px', padding: '0 16px 16px', minHeight: 0, overflow: 'hidden' }}>
        
        {/* Left Control Panel */}
        <section className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' }}>
          
          {/* File picker */}
          <div>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '14px' }}>
              <FileText size={16} color="var(--accent-primary)" />
              1. Pilih Dokumen
            </h3>
            <div 
              className={`dropzone ${dragActive ? 'active' : ''}`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-upload').click()}
              style={{ padding: '20px 10px' }}
            >
              <Upload size={24} color="var(--text-secondary)" style={{ marginBottom: '8px' }} />
              <p style={{ fontSize: '12px', fontWeight: '500' }}>
                {file ? file.name : 'Pilih file PDF atau DOCX'}
              </p>
              <input 
                id="file-upload" 
                type="file" 
                accept=".pdf,.docx" 
                onChange={(e) => e.target.files[0] && processFile(e.target.files[0])} 
                style={{ display: 'none' }} 
              />
            </div>
            
            {/* History Toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', fontSize: '12px' }}>
              <input 
                type="checkbox" 
                id="history-toggle" 
                checked={saveToHistory}
                onChange={(e) => setSaveToHistory(e.target.checked)}
                style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)' }}
              />
              <label htmlFor="history-toggle" style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>
                Simpan ke riwayat browser lokal
              </label>
            </div>
          </div>

          {/* Document History List */}
          {historyList.length > 0 && (
            <div>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '14px' }}>
                <History size={16} color="var(--accent-primary)" />
                Riwayat Dokumen ({historyList.length})
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '150px', overflowY: 'auto', paddingRight: '4px' }}>
                {historyList.map((item) => (
                  <div 
                    key={item.id}
                    onClick={() => loadHistoryItem(item)}
                    className="glass-panel"
                    style={{ 
                      display: 'flex', 
                      justifyContent: 'space-between', 
                      alignItems: 'center', 
                      padding: '8px 10px', 
                      borderRadius: '8px', 
                      fontSize: '12px', 
                      cursor: 'pointer',
                      background: file && file.name === item.name ? 'rgba(99, 102, 241, 0.1)' : 'rgba(255,255,255,0.02)',
                      border: file && file.name === item.name ? '1px solid rgba(99, 102, 241, 0.3)' : '1px solid var(--border-color)',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <span 
                      style={{ 
                        textOverflow: 'ellipsis', 
                        overflow: 'hidden', 
                        whiteSpace: 'nowrap', 
                        maxWidth: '190px',
                        color: file && file.name === item.name ? '#fff' : 'var(--text-secondary)',
                        fontWeight: file && file.name === item.name ? '600' : 'normal'
                      }}
                      title={item.name}
                    >
                      {item.name}
                    </span>
                    <button 
                      onClick={(e) => deleteHistoryItem(e, item.id)}
                      style={{ 
                        background: 'none', 
                        border: 'none', 
                        color: 'var(--text-muted)', 
                        cursor: 'pointer',
                        padding: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                      onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
                      title="Hapus dari riwayat"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Voice configuration */}
          <div>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '14px' }}>
              <Languages size={16} color="var(--accent-primary)" />
              2. Pengaturan TTS
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '2px' }}>
                  Filter Bahasa
                </label>
                <select 
                  value={languageFilter} 
                  onChange={(e) => setLanguageFilter(e.target.value)}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: '6px', background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: '#fff', fontSize: '13px' }}
                >
                  <option value="all">Semua ({voices.length})</option>
                  {languagesList.map(lang => (
                    <option key={lang} value={lang}>{lang.toUpperCase()}</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '2px' }}>
                  Pilih Suara
                </label>
                <select 
                  value={selectedVoice} 
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: '6px', background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: '#fff', fontSize: '13px' }}
                >
                  {filteredVoices.map(voice => {
                    const isNatural = voice.name.toLowerCase().includes('google') || 
                                      voice.name.toLowerCase().includes('microsoft') || 
                                      voice.name.toLowerCase().includes('natural');
                    return (
                      <option key={voice.name} value={voice.name}>
                        {voice.name} {isNatural ? '✨' : ''}
                      </option>
                    );
                  })}
                </select>
                <div style={{ marginTop: '8px', padding: '10px', background: 'rgba(99, 102, 241, 0.08)', borderRadius: '8px', border: '1px solid rgba(99, 102, 241, 0.2)', fontSize: '11px', lineHeight: '1.4' }}>
                  <span style={{ fontWeight: '600', color: 'var(--accent-primary)', display: 'block', marginBottom: '3px' }}>
                    📢 TIPS INTONASI MANUSIA (NATURAL):
                  </span>
                  1. Gunakan <strong>Microsoft Edge</strong> atau <strong>Google Chrome</strong>.<br/>
                  2. Pilih suara yang mengandung kata <strong>"Online"</strong> atau <strong>"Natural"</strong> (berlabel ✨).<br/>
                  3. Suara online buatan Microsoft/Google diolah secara neural di server cloud mereka, sehingga memiliki intonasi naik-turnun dan hembusan nafas yang sangat mirip manusia asli dibandingkan suara bawaan komputer offline yang kaku.
                </div>
              </div>
            </div>
          </div>

          {/* Sound adjustment */}
          <div>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '14px' }}>
              <Sliders size={16} color="var(--accent-primary)" />
              3. Penyesuaian Audio
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                  <span>Kecepatan</span>
                  <span>{rate}x</span>
                </div>
                <input 
                  type="range" min="0.5" max="2.0" step="0.1" value={rate} 
                  onChange={(e) => setRate(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-primary)' }}
                />
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                  <span>Nada</span>
                  <span>{pitch}x</span>
                </div>
                <input 
                  type="range" min="0.5" max="1.5" step="0.1" value={pitch} 
                  onChange={(e) => setPitch(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-primary)' }}
                />
              </div>
            </div>
          </div>

          {/* Page Info summary */}
          {pdfDoc && (
            <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border-color)', paddingTop: '12px', textAlign: 'center' }}>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Dokumen termuat: <strong>{numPages} Halaman</strong>
              </p>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: '1.4' }}>
                Ketuk kata mana saja pada dokumen untuk mulai membaca dari kata tersebut.
              </p>
            </div>
          )}

        </section>

        {/* Right Panel: Interactive Visual PDF Canvas / DOCX Display */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0, height: '100%', overflow: 'hidden' }}>
          
          {/* Top Controls Bar */}
          <div className="glass-panel" style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <button 
                onClick={prevItem} 
                disabled={textItems.length === 0 || currentItemIndex <= 0}
                className="glass-panel"
                style={{ padding: '8px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', border: '1px solid var(--border-color)' }}
              >
                <SkipBack size={14} />
              </button>

              {isPlaying && !isPaused ? (
                <button 
                  onClick={pauseReading}
                  className="glow-btn"
                  style={{ padding: '8px 16px', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}
                >
                  <Pause size={14} />
                  <span>Jeda</span>
                </button>
              ) : (
                <button 
                  onClick={resumeReading}
                  disabled={textItems.length === 0}
                  className="glow-btn"
                  style={{ padding: '8px 16px', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}
                >
                  <Play size={14} />
                  <span>{isPaused ? 'Lanjutkan' : 'Mulai Baca'}</span>
                </button>
              )}

              <button 
                onClick={stopReading} 
                disabled={!isPlaying}
                className="glass-panel"
                style={{ padding: '8px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', border: '1px solid var(--border-color)' }}
              >
                <Square size={14} />
              </button>

              <button 
                onClick={nextItem} 
                disabled={textItems.length === 0 || currentItemIndex >= textItems.length - 1}
                className="glass-panel"
                style={{ padding: '8px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', border: '1px solid var(--border-color)' }}
              >
                <SkipForward size={14} />
              </button>

              {/* Local Tab Audio Recorder Button */}
              {isRecording ? (
                <button 
                  onClick={stopRecordingAudio}
                  className="glow-btn"
                  style={{ padding: '8px 16px', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)' }}
                >
                  <Square size={14} />
                  <span className="animate-pulse">Stop Rekam</span>
                </button>
              ) : (
                <button 
                  onClick={startRecordingAudio}
                  disabled={textItems.length === 0}
                  className="glass-panel"
                  style={{ padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', color: '#fff', border: '1px solid var(--border-color)', fontSize: '13px' }}
                >
                  <Download size={14} />
                  <span>Ekspor Audio</span>
                </button>
              )}
            </div>

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', position: 'relative', overflow: 'hidden' }}>
                <div 
                  style={{ 
                    position: 'absolute', 
                    top: 0, 
                    left: 0, 
                    height: '100%', 
                    background: 'linear-gradient(90deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)',
                    width: textItems.length > 0 ? `${((currentItemIndex + 1) / textItems.length) * 100}%` : '0%',
                    transition: 'width 0.2s ease'
                  }} 
                />
              </div>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {textItems.length > 0 ? `${Math.round(((currentItemIndex + 1) / textItems.length) * 100)}%` : '0%'}
              </span>
            </div>
          </div>

          {/* Interactive Document Area */}
          <div 
            className="glass-panel"
            ref={containerRef}
            style={{ 
              flex: 1, 
              overflowY: 'auto', 
              padding: '24px', 
              display: 'flex', 
              flexDirection: 'column', 
              alignItems: 'center',
              background: '#07080c',
              position: 'relative'
            }}
          >
            {loading && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'absolute', top: '50%', transform: 'translateY(-50%)', gap: '12px' }}>
                <RefreshCw size={36} className="animate-spin" color="var(--accent-primary)" style={{ animation: 'spin 1.5s linear infinite' }} />
                <p style={{ fontSize: '14px' }}>Mengekstrak dan merender halaman dokumen...</p>
                <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
              </div>
            )}

            {error && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'absolute', top: '50%', transform: 'translateY(-50%)', gap: '10px', color: '#ef4444' }}>
                <AlertCircle size={36} />
                <p style={{ fontSize: '14px' }}>{error}</p>
              </div>
            )}

            {!loading && !error && !pdfDoc && !docxHtml && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'absolute', top: '40%', transform: 'translateY(-50%)', gap: '14px', color: 'var(--text-muted)' }}>
                <BookOpen size={40} />
                <div style={{ textAlign: 'center' }}>
                  <p style={{ fontSize: '15px', fontWeight: '500', color: 'var(--text-secondary)' }}>Tampilan Dokumen Kosong</p>
                  <p style={{ fontSize: '12px', marginTop: '2px' }}>Pilih file di panel kiri untuk memvisualisasikan isi dokumen.</p>
                </div>
              </div>
            )}

            {/* Rendering PDF Pages */}
            {pdfDoc && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', maxWidth: '800px' }}>
                {Array.from({ length: numPages }, (_, i) => i + 1).map(pageNum => {
                  return (
                    <div 
                      key={pageNum}
                      id={`page-container-${pageNum}`}
                      style={{ 
                        position: 'relative', 
                        width: '100%', 
                        display: 'block',
                        boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                        borderRadius: '8px',
                        overflow: 'hidden',
                        background: '#fff'
                      }}
                    >
                      {/* PDF Canvas Page */}
                      <canvas 
                        ref={el => canvasRefs.current[pageNum] = el}
                        style={{ display: 'block', width: '100%', height: 'auto' }}
                      />

                      {/* Bounding Box Highlights mapped on word level */}
                      {textItems
                        .filter(item => item.pageNum === pageNum)
                        .map((item, idx) => {
                          const globalIdx = textItems.indexOf(item);
                          const active = globalIdx === currentItemIndex;
                          
                          const canvasEl = canvasRefs.current[pageNum];
                          if (!canvasEl) return null;
                          
                          const scaleX = canvasEl.width / item.rect.pageW;
                          const scaleY = canvasEl.height / item.rect.pageH;

                          return (
                            <div
                              key={idx}
                              onClick={() => startReading(globalIdx)}
                              className={`pdf-text-overlay ${active ? 'active' : ''}`}
                              style={{
                                left: `${item.rect.x * scaleX}px`,
                                top: `${item.rect.y * scaleY}px`,
                                width: `${item.rect.w * scaleX}px`,
                                height: `${item.rect.h * scaleY}px`
                              }}
                              title={item.text}
                            />
                          );
                        })}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Rendering DOCX Document HTML Fallback */}
            {docxHtml && (
              <div 
                className="docx-viewer glass-panel"
                style={{ 
                  width: '100%', 
                  maxWidth: '800px', 
                  background: '#fff', 
                  color: '#333', 
                  padding: '40px', 
                  borderRadius: '8px', 
                  textAlign: 'left',
                  boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                  minHeight: '600px',
                  fontFamily: 'var(--font-sans)',
                  lineHeight: '1.8'
                }}
              >
                <div style={{ wordBreak: 'break-word' }}>
                  {textItems.map((item, idx) => {
                    const active = idx === currentItemIndex;
                    return (
                      <span 
                        key={idx}
                        onClick={() => startReading(idx)}
                        style={{ 
                          cursor: 'pointer', 
                          padding: '1px 3px', 
                          borderRadius: '3px',
                          background: active ? 'rgba(250, 204, 21, 0.35)' : 'transparent',
                          color: active ? '#000' : 'inherit',
                          fontWeight: active ? 'bold' : 'normal',
                          display: 'inline-block',
                          marginRight: '6px'
                        }}
                      >
                        {item.text}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

          </div>

        </section>

      </main>
    </div>
  );
}
