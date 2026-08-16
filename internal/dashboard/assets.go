package dashboard

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed assets
var assetsFS embed.FS

func Handler() http.Handler {
	sub, err := fs.Sub(assetsFS, "assets")
	if err != nil {
		panic("dashboard: " + err.Error())
	}

	assetExts := map[string]bool{}
	err = fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ext := path.Ext(p); !d.IsDir() && ext != "" {
			assetExts[ext] = true
		}
		return nil
	})
	if err != nil {
		panic("dashboard: " + err.Error())
	}

	files := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}

		if _, err := fs.Stat(sub, name); err != nil {
			if assetExts[path.Ext(name)] {
				http.NotFound(w, r)
				return
			}
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}

		files.ServeHTTP(w, r)
	})
}
