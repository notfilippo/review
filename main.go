package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"time"
)

const (
	localhost          = "127.0.0.1"
	defaultListenAddr  = localhost + ":7527"
	fallbackListenAddr = localhost + ":0"
	readHeaderTimeout  = 5 * time.Second
	shutdownTimeout    = 2 * time.Second
)

type stringListFlag []string

func (values *stringListFlag) String() string {
	return strings.Join(*values, ",")
}

func (values *stringListFlag) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return errors.New("revision cannot be empty")
	}
	*values = append(*values, value)
	return nil
}

type cliOptions struct {
	listenAddr        string
	allowPortFallback bool
	cwd               string
	revisions         []string
	fromRev           string
	toRev             string
	paths             []string
}

type reviewInput struct {
	patch string
	vcs   *vcsSource
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "review:", err)
		os.Exit(1)
	}
}

func run() error {
	options, err := parseCLI(os.Args[1:])
	if err != nil {
		return err
	}

	input, err := loadVCSReviewInput(options)
	if err != nil {
		return err
	}

	session, err := newReviewSession(input)
	if err != nil {
		return err
	}

	return serveReview(options, session)
}

func parseCLI(args []string) (cliOptions, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return cliOptions{}, err
	}

	flagSet := flag.NewFlagSet("review", flag.ContinueOnError)
	flagSet.SetOutput(os.Stderr)
	addr := flagSet.String("addr", defaultListenAddr, "listen address for the review UI")
	port := flagSet.String("port", "", "listen port on 127.0.0.1")
	fromRev := flagSet.String("from", "", "base revision for VCS diff")
	toRev := flagSet.String("to", "", "target revision for VCS diff")
	var revisions stringListFlag
	flagSet.Var(&revisions, "r", "revision or revset to review")
	if err := flagSet.Parse(args); err != nil {
		return cliOptions{}, err
	}

	var addrSet, portSet bool
	flagSet.Visit(func(flagValue *flag.Flag) {
		switch flagValue.Name {
		case "addr":
			addrSet = true
		case "port":
			portSet = true
		}
	})
	if addrSet && portSet {
		return cliOptions{}, errors.New("use -addr or -port, not both")
	}

	listenAddr := strings.TrimSpace(*addr)
	if portSet {
		portValue := strings.TrimSpace(*port)
		if portValue == "" {
			return cliOptions{}, errors.New("-port cannot be empty")
		}
		listenAddr = localhost + ":" + portValue
	}
	if listenAddr == "" {
		return cliOptions{}, errors.New("-addr cannot be empty")
	}

	options := cliOptions{
		listenAddr:        listenAddr,
		allowPortFallback: !addrSet && !portSet,
		cwd:               cwd,
		revisions:         []string(revisions),
		fromRev:           strings.TrimSpace(*fromRev),
		toRev:             strings.TrimSpace(*toRev),
		paths:             flagSet.Args(),
	}
	if len(options.revisions) > 0 && (options.fromRev != "" || options.toRev != "") {
		return cliOptions{}, errors.New("use -r or -from/-to, not both")
	}
	return options, nil
}

func serveReview(options cliOptions, session *reviewSession) error {
	listener, err := net.Listen("tcp", options.listenAddr)
	if err != nil && options.allowPortFallback {
		listener, err = net.Listen("tcp", fallbackListenAddr)
	}
	if err != nil {
		return err
	}

	server := &http.Server{
		Handler:           session.routes(),
		ReadHeaderTimeout: readHeaderTimeout,
	}
	serverErr := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
			return
		}
		serverErr <- nil
	}()

	url := fmt.Sprintf("http://%s/?token=%s", listener.Addr().String(), session.token)
	fmt.Fprintf(os.Stderr, "Review UI: %s\n", url)
	if err := openBrowser(url); err != nil {
		fmt.Fprintf(os.Stderr, "Could not open browser: %v\n", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	select {
	case <-session.done:
	case err := <-serverErr:
		if err != nil {
			return err
		}
		return errors.New("server stopped before review completed")
	case <-ctx.Done():
		return errors.New("review cancelled")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-serverErr; err != nil {
		return err
	}

	_, err = io.WriteString(os.Stdout, formatMarkdown(session.finalComments(), session.files))
	return err
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
