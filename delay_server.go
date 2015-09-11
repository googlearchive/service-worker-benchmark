package main

import (
  "net/http"
  "time"
  "flag"
  "fmt"
  "strings"
)

type DelayServer struct {
  Delay time.Duration
  Inner http.Handler
}

type DelayWriter struct {
  Inner http.ResponseWriter
  Cond chan bool
}

func (dw *DelayWriter) block() {
  _, _ = <-dw.Cond
}

func (dw *DelayWriter) Send() {
  close(dw.Cond)
}

func (dw *DelayWriter) Header() http.Header {
  return dw.Inner.Header()
}

func (dw *DelayWriter) Write(b []byte) (int, error) {
  dw.block()
  return dw.Inner.Write(b)
}

func (dw *DelayWriter) WriteHeader(c int) {
  dw.block()
  dw.Inner.WriteHeader(c)
}

func (ds *DelayServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
  if strings.Contains(r.URL.Path, "/_") { // skip delay on worker start
    ds.Inner.ServeHTTP(w, r)
    return
  }
  t := time.After(ds.Delay)
  dw := &DelayWriter{w, make(chan bool)}
  go func() {
    <-t
    dw.Send()
  }()
  ds.Inner.ServeHTTP(dw, r)
}

var delay = flag.Int("delay", 0, "enforced network-side latency")
var port = flag.String("http", "127.0.0.1:9000", "where to bind")

func main() {
  flag.Parse()
  fmt.Printf("Running %dms server on %s.\n", *delay, *port)
  http.Handle("/", &DelayServer{
    Delay: time.Duration(*delay) * time.Millisecond,
    Inner: http.FileServer(http.Dir(".")),
  })
  panic(http.ListenAndServe(*port, nil))
}
