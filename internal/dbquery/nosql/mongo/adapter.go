// Package mongo implements the MongoDB engine for Db Studio's NoSQL layer.
//
// It is the document-store sibling of internal/dbquery/nosql/redis. The
// concrete *Adapter type satisfies the nosql.Adapter contract (Protocol /
// Family / Info) that D1's Registry keys on, and additionally exposes the
// document-store operations — database/collection listing, CRUD, aggregation
// (behind a security gate) and index management — that the D4 HTTP handlers
// bind to directly. Only the three interface methods are reached through the
// Registry; the rest are engine-specific and so live on the concrete type.
//
// Every method is nil-safe: a *Adapter built with New(nil), or any method
// receiver that is nil, returns a descriptive "not connected" error rather
// than panicking, so the gateway can construct an adapter speculatively
// before the underlying *mongo.Client is dialled.
package mongo

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/michongs/wayfort/internal/dbquery/nosql"
)

// Adapter is the MongoDB engine plugin. A zero-value or nil-client instance
// is constructible and reports Protocol/Family, but every server-touching
// method returns errNotConnected until a real *mongo.Client is supplied.
type Adapter struct {
	client *mongo.Client
}

// Compile-time assertion that *Adapter satisfies the nosql.Adapter contract.
// If a future edit to the interface breaks this, the package fails to build
// here rather than at the Registry call site in D4.
var _ nosql.Adapter = (*Adapter)(nil)

// New returns a MongoDB adapter wrapping the supplied client. The client may
// be nil; callers then receive errNotConnected from every server-touching
// method until a live client is provided.
func New(client *mongo.Client) *Adapter { return &Adapter{client: client} }

// Protocol reports the model.NodeProtocol id this adapter serves. It is the
// Registry key and the value the front-end matches against node config.
func (a *Adapter) Protocol() string { return "mongodb" }

// Family reports the compatibility band, routing the UI shell to the document
// editor rather than the Redis key editor.
func (a *Adapter) Family() nosql.Family { return nosql.FamilyMongoDB }

// Sentinel errors. Declared once so call sites stay one-liners and so tests
// can assert against errors.Is without re-deriving the message string.
var (
	errNotConnected = errors.New("mongo: adapter not connected (nil client)")
	// errForbiddenPipeline is returned by Aggregate when the pipeline tries
	// to write outside the source collection. See IsForbiddenPipeline.
	errForbiddenPipeline = errors.New("mongo: pipeline contains a forbidden stage ($out / $merge)")
)

// mustClient returns the underlying client or errNotConnected. Centralising
// the nil guard keeps every server-touching method a one-liner check.
func (a *Adapter) mustClient() (*mongo.Client, error) {
	if a == nil || a.client == nil {
		return nil, errNotConnected
	}
	return a.client, nil
}

// requireDB validates that a database name is non-empty.
func requireDB(db string) error {
	if db == "" {
		return errors.New("mongo: database name must be non-empty")
	}
	return nil
}

// requireColl validates a db+coll pair, the most common parameter shape.
func requireColl(db, coll string) error {
	if err := requireDB(db); err != nil {
		return err
	}
	if coll == "" {
		return errors.New("mongo: collection name must be non-empty")
	}
	return nil
}

// Info gathers buildInfo + serverStatus for the connection panel.
//
// buildInfo is reachable by any authenticated user and supplies the version.
// serverStatus carries uptime, the storage-engine name and the rich gauge
// set, but it demands elevated privileges, so it is treated as best-effort:
// an authorisation failure leaves the buildInfo-derived defaults in place
// rather than failing the whole panel.
func (a *Adapter) Info(ctx context.Context) (nosql.Info, error) {
	client, err := a.mustClient()
	if err != nil {
		return nosql.Info{}, err
	}
	admin := client.Database("admin")

	var build buildInfo
	if err := admin.RunCommand(ctx, bson.D{{Key: "buildInfo", Value: 1}}).Decode(&build); err != nil {
		return nosql.Info{}, fmt.Errorf("mongo buildInfo: %w", err)
	}
	info := nosql.Info{Version: build.Version, StorageEngine: "mongodb"}

	var ss bson.M
	if err := admin.RunCommand(ctx, bson.D{{Key: "serverStatus", Value: 1}}).Decode(&ss); err == nil {
		info.Uptime = asInt64(ss["uptime"])
		if se, ok := ss["storageEngine"].(bson.M); ok {
			if name, ok := se["name"].(string); ok && name != "" {
				info.StorageEngine = name
			}
		}
		info.ServerStatus = ss
	}
	return info, nil
}

// Databases lists non-system databases. admin/config/local are filtered
// because they are cluster-internal and never user-editable; surfacing them
// in the database picker would invite confusion. Results are sorted so the
// picker is stable across calls.
func (a *Adapter) Databases(ctx context.Context) ([]string, error) {
	client, err := a.mustClient()
	if err != nil {
		return nil, err
	}
	names, err := client.ListDatabaseNames(ctx, bson.D{})
	if err != nil {
		return nil, fmt.Errorf("mongo listDatabases: %w", err)
	}
	out := make([]string, 0, len(names))
	for _, n := range names {
		if isSystemDatabase(n) {
			continue
		}
		out = append(out, n)
	}
	sort.Strings(out)
	return out, nil
}

// Collections lists user collections in a database. Cluster-internal
// collections (the "system." prefix) are filtered for the same reason as
// system databases. Results are sorted for a stable picker.
func (a *Adapter) Collections(ctx context.Context, db string) ([]string, error) {
	client, err := a.mustClient()
	if err != nil {
		return nil, err
	}
	if err := requireDB(db); err != nil {
		return nil, err
	}
	names, err := client.Database(db).ListCollectionNames(ctx, bson.D{})
	if err != nil {
		return nil, fmt.Errorf("mongo listCollections: %w", err)
	}
	out := make([]string, 0, len(names))
	for _, n := range names {
		if strings.HasPrefix(n, "system.") {
			continue
		}
		out = append(out, n)
	}
	sort.Strings(out)
	return out, nil
}

// Documents queries a collection with filter/sort/projection/pagination and
// returns the matching docs plus the total match count (pre-pagination).
// The count is a separate CountDocuments call so the caller can render
// pagination controls without re-issuing the filter. nil maps for sort or
// projection are ignored.
func (a *Adapter) Documents(ctx context.Context, db, coll string, filter map[string]any, sort map[string]any, projection map[string]any, limit, skip int64) ([]map[string]any, int64, error) {
	client, err := a.mustClient()
	if err != nil {
		return nil, 0, err
	}
	if err := requireColl(db, coll); err != nil {
		return nil, 0, err
	}
	c := client.Database(db).Collection(coll)

	opts := options.Find()
	if sort != nil {
		opts.SetSort(sort)
	}
	if projection != nil {
		opts.SetProjection(projection)
	}
	if limit > 0 {
		opts.SetLimit(limit)
	}
	if skip > 0 {
		opts.SetSkip(skip)
	}

	cur, err := c.Find(ctx, filter, opts)
	if err != nil {
		return nil, 0, fmt.Errorf("mongo find: %w", err)
	}
	var docs []map[string]any
	if err := cur.All(ctx, &docs); err != nil {
		return nil, 0, fmt.Errorf("mongo find decode: %w", err)
	}
	total, err := c.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, fmt.Errorf("mongo count: %w", err)
	}
	return docs, total, nil
}

// FindOne returns the first document matching filter, or (nil, nil) when
// nothing matches. Mapping ErrNoDocuments to a nil result keeps the caller's
// "found vs not-found" branch a single nil check.
func (a *Adapter) FindOne(ctx context.Context, db, coll string, filter map[string]any) (map[string]any, error) {
	client, err := a.mustClient()
	if err != nil {
		return nil, err
	}
	if err := requireColl(db, coll); err != nil {
		return nil, err
	}
	sr := client.Database(db).Collection(coll).FindOne(ctx, filter)
	var doc map[string]any
	if err := sr.Decode(&doc); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, fmt.Errorf("mongo findOne: %w", err)
	}
	return doc, nil
}

// InsertOne inserts a single document and returns its _id (driver-generated
// ObjectID when the document omits one).
func (a *Adapter) InsertOne(ctx context.Context, db, coll string, doc map[string]any) (any, error) {
	client, err := a.mustClient()
	if err != nil {
		return nil, err
	}
	if err := requireColl(db, coll); err != nil {
		return nil, err
	}
	res, err := client.Database(db).Collection(coll).InsertOne(ctx, doc)
	if err != nil {
		return nil, fmt.Errorf("mongo insertOne: %w", err)
	}
	return res.InsertedID, nil
}

// UpdateOne applies an update expression to the first matching document and
// returns the modified count. update may be a $set expression, a replacement
// document, or an aggregation pipeline — the driver distinguishes them.
func (a *Adapter) UpdateOne(ctx context.Context, db, coll string, filter, update map[string]any) (int64, error) {
	client, err := a.mustClient()
	if err != nil {
		return 0, err
	}
	if err := requireColl(db, coll); err != nil {
		return 0, err
	}
	res, err := client.Database(db).Collection(coll).UpdateOne(ctx, filter, update)
	if err != nil {
		return 0, fmt.Errorf("mongo updateOne: %w", err)
	}
	return res.ModifiedCount, nil
}

// DeleteOne removes the first document matching filter and returns the
// deleted count (0 when nothing matched).
func (a *Adapter) DeleteOne(ctx context.Context, db, coll string, filter map[string]any) (int64, error) {
	client, err := a.mustClient()
	if err != nil {
		return 0, err
	}
	if err := requireColl(db, coll); err != nil {
		return 0, err
	}
	res, err := client.Database(db).Collection(coll).DeleteOne(ctx, filter)
	if err != nil {
		return 0, fmt.Errorf("mongo deleteOne: %w", err)
	}
	return res.DeletedCount, nil
}

// Aggregate runs an aggregation pipeline after the security gate rejects any
// stage that writes outside the source collection ($out/$merge). Each stage
// is a single-key map; the driver receives the slice as-is.
func (a *Adapter) Aggregate(ctx context.Context, db, coll string, pipeline []map[string]any) ([]map[string]any, error) {
	client, err := a.mustClient()
	if err != nil {
		return nil, err
	}
	if err := requireColl(db, coll); err != nil {
		return nil, err
	}
	if IsForbiddenPipeline(pipeline) {
		return nil, errForbiddenPipeline
	}
	cur, err := client.Database(db).Collection(coll).Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("mongo aggregate: %w", err)
	}
	var docs []map[string]any
	if err := cur.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("mongo aggregate decode: %w", err)
	}
	return docs, nil
}

// Indexes lists every index on a collection as a map per row, ready for JSON
// serialisation to the index catalogue endpoint.
func (a *Adapter) Indexes(ctx context.Context, db, coll string) ([]map[string]any, error) {
	client, err := a.mustClient()
	if err != nil {
		return nil, err
	}
	if err := requireColl(db, coll); err != nil {
		return nil, err
	}
	cur, err := client.Database(db).Collection(coll).Indexes().List(ctx)
	if err != nil {
		return nil, fmt.Errorf("mongo listIndexes: %w", err)
	}
	var out []map[string]any
	if err := cur.All(ctx, &out); err != nil {
		return nil, fmt.Errorf("mongo listIndexes decode: %w", err)
	}
	return out, nil
}

// CreateIndex builds a single index from a spec map. spec must carry a "keys"
// entry — an order-preserving key document such as {"name": 1}; the optional
// "name", "unique" and "sparse" fields populate IndexOptions. Any other field
// is ignored (a Phase 3D.9 hardening pass can surface the full option set).
func (a *Adapter) CreateIndex(ctx context.Context, db, coll string, spec map[string]any) error {
	client, err := a.mustClient()
	if err != nil {
		return err
	}
	if err := requireColl(db, coll); err != nil {
		return err
	}
	keys, ok := spec["keys"]
	if !ok {
		return errors.New("mongo createIndex: spec missing \"keys\"")
	}
	idxOpts := options.Index()
	if v, ok := spec["name"].(string); ok && v != "" {
		idxOpts.SetName(v)
	}
	if v, ok := spec["unique"].(bool); ok && v {
		idxOpts.SetUnique(true)
	}
	if v, ok := spec["sparse"].(bool); ok && v {
		idxOpts.SetSparse(true)
	}
	model := mongo.IndexModel{Keys: keys, Options: idxOpts}
	if _, err := client.Database(db).Collection(coll).Indexes().CreateOne(ctx, model); err != nil {
		return fmt.Errorf("mongo createIndex: %w", err)
	}
	return nil
}

// buildInfo is the subset of the buildInfo command response we surface.
type buildInfo struct {
	Version string `bson:"version"`
}

// isSystemDatabase reports whether db is one of the cluster-internal
// databases that never hold user data.
func isSystemDatabase(db string) bool {
	switch db {
	case "admin", "config", "local":
		return true
	}
	return false
}

// asInt64 coerces a BSON numeric field to int64. MongoDB numbers arrive as
// int32/int64/float32/float64 depending on magnitude; the uptime display
// tolerates any of them, so we collapse the cases here.
func asInt64(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int32:
		return int64(n)
	case int64:
		return n
	case float32:
		return int64(n)
	case float64:
		return int64(n)
	}
	return 0
}
