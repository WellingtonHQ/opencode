# Code Styles

## SQL Lists

In SQL lists, put each column and each corresponding value or placeholder on
its own line. Keep corresponding columns and values in the same order. This
applies to SQL embedded in application code as well as standalone SQL.

**Do:**
```sql
INSERT INTO users (
    id,
    name
) VALUES (
    :id,
    :name
);
```

**Don't:**
```sql
INSERT INTO users (id, name) VALUES (:id, :name);
```
