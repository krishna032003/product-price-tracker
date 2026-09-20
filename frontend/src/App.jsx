import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Search, Plus, LineChart as LineChartIcon, Activity, AlertCircle, RefreshCw, Zap } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const supabase = supabaseUrl ? createClient(supabaseUrl, supabaseKey) : null;

function App() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [trackedProducts, setTrackedProducts] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [scrapeLogs, setScrapeLogs] = useState([]);
  const [isScrapingNow, setIsScrapingNow] = useState(false);
  const [activeScrapeId, setActiveScrapeId] = useState(null);

  useEffect(() => {
    if (supabase) {
      fetchTrackedProducts();
    }
  }, []);

  useEffect(() => {
    if (selectedProduct && supabase) {
      fetchProductHistory(selectedProduct.id);
      fetchProductLogs(selectedProduct.id);
    }
  }, [selectedProduct]);

  const fetchTrackedProducts = async () => {
    const { data } = await supabase
      .from('tracked_products')
      .select('*')
      .order('added_at', { ascending: false });
    
    if (data) {
      setTrackedProducts(data);
      if (data.length > 0 && !selectedProduct) {
        setSelectedProduct(data[0]);
      }
    }
  };

  const fetchProductHistory = async (id) => {
    const { data } = await supabase
      .from('price_history')
      .select('*')
      .eq('tracked_product_id', id)
      .order('scraped_at', { ascending: true });
    
    if (data) {
      const formatted = data.map(d => ({
        ...d,
        time: new Date(d.scraped_at).toLocaleDateString() + ' ' + new Date(d.scraped_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
      }));
      setPriceHistory(formatted);
    }
  };

  const fetchProductLogs = async (id) => {
    const { data } = await supabase
      .from('scrape_logs')
      .select('*')
      .eq('tracked_product_id', id)
      .order('attempted_at', { ascending: false })
      .limit(20);
    
    if (data) setScrapeLogs(data);
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery) return;
    setIsSearching(true);
    try {
      const res = await fetch(`${apiUrl}/api/catalog?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setSearchResults(data.items || []);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSearching(false);
    }
  };

  const trackProduct = async (product) => {
    if (!supabase) return alert('Supabase not configured');
    
    const { data, error } = await supabase.from('tracked_products').insert({
      product_id: product.id.toString(),
      slug: product.slug,
      name: product.name,
      brand: product.brand
    }).select();

    if (error) {
      if (error.code === '23505') alert('Product already tracked');
      else alert('Error tracking product: ' + error.message);
    } else {
      await fetchTrackedProducts();
      setSearchResults([]);
      setSearchQuery('');
      if (data && data[0]) {
        setSelectedProduct(data[0]);
        // Trigger initial scrape for newly added product automatically
        handleScrapeNow(data[0].id);
      }
    }
  };

  const handleScrapeNow = async (productId) => {
    const idToScrape = productId || selectedProduct?.id;
    if (!idToScrape) return;

    setIsScrapingNow(true);
    setActiveScrapeId(idToScrape);

    try {
      const res = await fetch(`${apiUrl}/api/products/${idToScrape}/scrape`, {
        method: 'POST'
      });
      const data = await res.json();

      if (res.ok && data.success) {
        await fetchTrackedProducts();
        if (selectedProduct && (selectedProduct.id === idToScrape || selectedProduct.product_id === idToScrape)) {
          await fetchProductHistory(selectedProduct.id);
          await fetchProductLogs(selectedProduct.id);
        }
      } else {
        alert(data.error || 'Scrape failed. Check scrape logs below.');
        if (selectedProduct) await fetchProductLogs(selectedProduct.id);
      }
    } catch (err) {
      console.error('Manual scrape error:', err);
      alert('Could not reach backend scraper. Ensure the backend server is running.');
    } finally {
      setIsScrapingNow(false);
      setActiveScrapeId(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans p-6">
      <header className="max-w-6xl mx-auto mb-8 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">
            INE Price Tracker
          </h1>
          <p className="text-gray-500">Monitor mock store prices and availability in real-time</p>
        </div>
        {selectedProduct && (
          <button
            onClick={() => handleScrapeNow(selectedProduct.id)}
            disabled={isScrapingNow}
            className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold px-5 py-2.5 rounded-xl shadow-md hover:from-blue-700 hover:to-indigo-700 transition disabled:opacity-50"
          >
            {isScrapingNow ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Scraping Store...</span>
              </>
            ) : (
              <>
                <Zap className="w-4 h-4 fill-current text-yellow-300" />
                <span>Scrape Now</span>
              </>
            )}
          </button>
        )}
      </header>

      <main className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
        
        {/* Left Sidebar - Tracked Products & Search */}
        <div className="md:col-span-1 space-y-6">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Search className="w-5 h-5 text-gray-400" /> Find Product
            </h2>
            <form onSubmit={handleSearch} className="flex gap-2">
              <input 
                type="text" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search mock store..." 
                className="flex-1 border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition text-sm font-medium">
                {isSearching ? <RefreshCw className="w-4 h-4 animate-spin" /> : 'Search'}
              </button>
            </form>

            {searchResults.length > 0 && (
              <div className="mt-4 max-h-64 overflow-y-auto space-y-2">
                {searchResults.map(p => (
                  <div key={p.id} className="p-3 bg-gray-50 rounded-lg flex justify-between items-center group hover:bg-blue-50 transition">
                    <div>
                      <p className="font-medium text-sm truncate w-44">{p.name}</p>
                      <p className="text-xs text-gray-500">{p.brand}</p>
                    </div>
                    <button 
                      onClick={() => trackProduct(p)} 
                      title="Track Product"
                      className="text-blue-600 p-1.5 rounded-lg hover:bg-blue-100 opacity-0 group-hover:opacity-100 transition"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Activity className="w-5 h-5 text-gray-400" /> Tracked Items
            </h2>
            {trackedProducts.length === 0 ? (
              <p className="text-sm text-gray-500">No products tracked yet. Search above to add products.</p>
            ) : (
              <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                {trackedProducts.map(tp => (
                  <div 
                    key={tp.id} 
                    onClick={() => setSelectedProduct(tp)}
                    className={`p-4 rounded-xl border cursor-pointer transition ${selectedProduct?.id === tp.id ? 'border-blue-500 bg-blue-50/50 shadow-sm' : 'border-gray-100 hover:border-gray-200 bg-white'}`}
                  >
                    <div className="flex justify-between items-start">
                      <p className="font-medium text-sm line-clamp-1 flex-1">{tp.name}</p>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedProduct(tp);
                          handleScrapeNow(tp.id);
                        }}
                        disabled={isScrapingNow}
                        title="Scrape this product now"
                        className="ml-2 text-xs font-medium text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded flex items-center gap-1 transition"
                      >
                        {activeScrapeId === tp.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                        Scrape
                      </button>
                    </div>
                    <div className="mt-2.5 flex justify-between items-center text-xs">
                      <span className="font-bold text-gray-900 text-sm">
                        {tp.latest_price ? `₹${Number(tp.latest_price).toLocaleString('en-IN')}` : 'Pending scrape'}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full font-medium ${tp.latest_stock_status?.toLowerCase().includes('out') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                        {tp.latest_stock_status || 'Unknown'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Content - Analytics & Logs */}
        <div className="md:col-span-2 space-y-6">
          {selectedProduct ? (
            <>
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h2 className="text-xl font-bold flex items-center gap-2">
                      <LineChartIcon className="w-5 h-5 text-blue-600" /> {selectedProduct.name}
                    </h2>
                    <p className="text-xs text-gray-500 mt-1">Catalog ID: #{selectedProduct.product_id} · Brand: {selectedProduct.brand}</p>
                  </div>
                  <button
                    onClick={() => handleScrapeNow(selectedProduct.id)}
                    disabled={isScrapingNow}
                    className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow-sm transition disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isScrapingNow && activeScrapeId === selectedProduct.id ? 'animate-spin' : ''}`} />
                    {isScrapingNow && activeScrapeId === selectedProduct.id ? 'Scraping...' : 'Scrape Now'}
                  </button>
                </div>
                
                {priceHistory.length > 0 ? (
                  <div className="h-72 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={priceHistory}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                        <XAxis dataKey="time" tick={{fontSize: 11}} tickMargin={8} minTickGap={30} />
                        <YAxis domain={['auto', 'auto']} tick={{fontSize: 11}} tickFormatter={(v) => `₹${Number(v).toLocaleString('en-IN')}`} />
                        <Tooltip 
                          formatter={(value) => [`₹${Number(value).toLocaleString('en-IN')}`, 'Price']}
                          contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}}
                        />
                        <Line type="monotone" dataKey="price" stroke="#2563eb" strokeWidth={3} dot={{r: 4, fill: '#2563eb', strokeWidth: 0}} activeDot={{r: 6}} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="h-72 flex flex-col items-center justify-center bg-gray-50 rounded-xl border border-dashed text-center p-6">
                    <p className="text-gray-500 text-sm mb-3">No price history recorded yet for this item.</p>
                    <button
                      onClick={() => handleScrapeNow(selectedProduct.id)}
                      disabled={isScrapingNow}
                      className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-xl shadow transition"
                    >
                      <Zap className="w-4 h-4 text-yellow-300 fill-current" />
                      Trigger First Scrape Now
                    </button>
                  </div>
                )}
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-lg font-semibold">Scrape Logs</h2>
                  <span className="text-xs text-gray-400">Shows recent 20 attempts</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-xs text-gray-500 uppercase bg-gray-50 rounded-lg">
                      <tr>
                        <th className="px-4 py-3 rounded-l-lg">Time</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Duration</th>
                        <th className="px-4 py-3 rounded-r-lg">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scrapeLogs.map((log) => (
                        <tr key={log.id} className="border-b last:border-0 hover:bg-gray-50">
                          <td className="px-4 py-3 whitespace-nowrap text-gray-600 text-xs">
                            {new Date(log.attempted_at).toLocaleString()}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                              log.status === 'SUCCESS' ? 'bg-green-100 text-green-700' : 
                              log.status === 'RETRIED' ? 'bg-yellow-100 text-yellow-700' : 
                              'bg-red-100 text-red-700'
                            }`}>
                              {log.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-xs">{log.duration_ms ? `${log.duration_ms}ms` : '-'}</td>
                          <td className="px-4 py-3 text-xs">
                            {log.status === 'SUCCESS' ? (
                              <span className="text-gray-700 font-medium">
                                {log.scraped_price_raw || 'Price recorded'} · {log.scraped_stock_status || 'In stock'}
                              </span>
                            ) : (
                              <span className="text-red-500 flex items-center gap-1">
                                <AlertCircle className="w-3.5 h-3.5" /> {log.error_message || 'Failed'}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {scrapeLogs.length === 0 && (
                    <p className="text-center text-gray-500 py-6 text-sm">No scrape logs available yet. Click "Scrape Now" to test.</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="h-full min-h-[400px] flex items-center justify-center bg-white rounded-2xl shadow-sm border border-gray-100">
              <div className="text-center text-gray-500">
                <Activity className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p>Select a tracked product to view its price history and logs</p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
