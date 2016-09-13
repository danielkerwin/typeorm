import {ForeignKeyMetadata} from "../metadata/ForeignKeyMetadata";
import {EntityMetadataCollection} from "../metadata-args/collection/EntityMetadataCollection";
import {TableSchema} from "./database-schema/TableSchema";
import {ColumnSchema} from "./database-schema/ColumnSchema";
import {ForeignKeySchema} from "./database-schema/ForeignKeySchema";
import {IndexSchema} from "./database-schema/IndexSchema";
import {Driver} from "../driver/Driver";
import {QueryRunner} from "../driver/QueryRunner";
import {NamingStrategyInterface} from "../naming-strategy/NamingStrategyInterface";
import {Logger} from "../logger/Logger";
import {PrimaryKeySchema} from "./database-schema/PrimaryKeySchema";
import {ColumnMetadata} from "../metadata/ColumnMetadata";

/**
 * Creates complete tables schemas in the database based on the entity metadatas.
 *
 * Steps how schema is being built:
 * 1. load list of all tables with complete column and keys information from the db
 * 2. drop all (old) foreign keys that exist in the table, but does not exist in the metadata
 * 3. create new tables that does not exist in the db, but exist in the metadata
 * 4. drop all columns exist (left old) in the db table, but does not exist in the metadata
 * 5. add columns from metadata which does not exist in the table
 * 6. update all exist columns which metadata has changed
 * 7. update primary keys - update old and create new primary key from changed columns
 * 8. create foreign keys which does not exist in the table yet
 * 9. create indices which are missing in db yet, and drops indices which exist in the db, but does not exist in the metadata anymore
 *
 * @internal
 */
export class SchemaBuilder {

    // -------------------------------------------------------------------------
    // Private Properties
    // -------------------------------------------------------------------------

    /**
     * Used to execute schema creation queries in a single connection.
     */
    protected queryRunner: QueryRunner;

    /**
     * All synchronized tables in the database.
     */
    protected tableSchemas: TableSchema[];
    
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @param driver Driver needs to create a query runner
     * @param logger Used to log schema creation events
     * @param entityMetadatas All entities to create schema for
     * @param namingStrategy Naming strategy used to generate special names
     */
    constructor(protected driver: Driver,
                protected logger: Logger,
                protected entityMetadatas: EntityMetadataCollection,
                protected namingStrategy: NamingStrategyInterface) {
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Creates complete schemas for the given entity metadatas.
     */
    async build(): Promise<void> {
        this.queryRunner = await this.driver.createQueryRunner();
        this.tableSchemas = await this.loadTableSchemas();

        await this.queryRunner.beginTransaction();
        try {
            await this.dropOldForeignKeys();
            await this.createNewTables();
            await this.dropRemovedColumns();
            await this.addNewColumns();
            await this.updateExistColumns();
            await this.updatePrimaryKeys();
            await this.createForeignKeys();
            await this.createIndices();
            await this.queryRunner.commitTransaction();

        } catch (error) {
            await this.queryRunner.rollbackTransaction();
            throw error;

        } finally {
            await this.queryRunner.release();
        }
    }

    // -------------------------------------------------------------------------
    // Private Methods
    // -------------------------------------------------------------------------

    /**
     * Loads all table schemas from the database.
     */
    protected loadTableSchemas(): Promise<TableSchema[]> {
        const tableNames = this.entityMetadatas.map(metadata => metadata.table.name);
        return this.queryRunner.loadSchemaTables(tableNames, this.namingStrategy);
    }

    /**
     * Drops all (old) foreign keys that exist in the table schemas, but do not exist in the entity metadata.
     */
    protected async dropOldForeignKeys(): Promise<void> {
        await Promise.all(this.entityMetadatas.map(async metadata => {

            const tableSchema = this.tableSchemas.find(table => table.name === metadata.table.name);
            if (!tableSchema)
                return;

            // find foreign keys that exist in the schemas but does not exist in the entity metadata
            const foreignKeySchemasToDrop = tableSchema.foreignKeys.filter(foreignKeySchema => {
                return !metadata.foreignKeys.find(metadataForeignKey => metadataForeignKey.name === foreignKeySchema.name);
            });
            if (foreignKeySchemasToDrop.length === 0)
                return;

            this.logger.logSchemaBuild(`dropping old foreign keys of ${tableSchema.name}: ${foreignKeySchemasToDrop.map(dbForeignKey => dbForeignKey.name).join(", ")}`);

            // remove foreign keys from the table schema
            tableSchema.removeForeignKeys(foreignKeySchemasToDrop);

            // drop foreign keys from the database
            await this.queryRunner.dropForeignKeys(tableSchema, foreignKeySchemasToDrop);
        }));
    }

    /**
     * Creates tables that do not exist in the database yet.
     * New tables are created without foreign and primary keys.
     * Primary key only can be created in conclusion with auto generated column.
     */
    protected async createNewTables(): Promise<void> {
        await Promise.all(this.entityMetadatas.map(async metadata => {

            // check if table does not exist yet
            const existTableSchema = this.tableSchemas.find(table => table.name === metadata.table.name);
            if (existTableSchema)
                return;

            this.logger.logSchemaBuild(`creating a new table: ${metadata.table.name}`);

            // create a new table schema and sync it in the database
            const tableSchema = new TableSchema(metadata.table.name, this.metadataColumnsToColumnSchemas(metadata.columns));
            this.tableSchemas.push(tableSchema);
            await this.queryRunner.createTable(tableSchema);
        }));
    }

    /**
     * Drops all columns that exist in the table, but does not exist in the metadata (left old).
     * We drop their keys too, since it should be safe.
     */
    protected dropRemovedColumns() {
        return Promise.all(this.entityMetadatas.map(async metadata => {
            const tableSchema = this.tableSchemas.find(table => table.name === metadata.table.name);
            if (!tableSchema) return;

            // find columns that exist in the database but does not exist in the metadata
            const droppedColumnSchemas = tableSchema.columns.filter(columnSchema => {
                return !metadata.columns.find(columnMetadata => columnMetadata.name === columnSchema.name);
            });
            if (droppedColumnSchemas.length === 0)
                return;

            // drop all foreign keys that has column to be removed in its columns
            await Promise.all(droppedColumnSchemas.map(async droppedColumnSchema => {
                return this.dropColumnReferencedForeignKeys(metadata.table.name, droppedColumnSchema.name);
            }));

            this.logger.logSchemaBuild(`columns dropped in ${tableSchema.name}: ` + droppedColumnSchemas.map(column => column.name).join(", "));

            // remove columns from the table schema and primary keys of it if its used in the primary keys
            tableSchema.removeColumns(droppedColumnSchemas);
            tableSchema.removePrimaryKeysOfColumns(droppedColumnSchemas);

            // drop columns from the database
            await this.queryRunner.dropColumns(tableSchema, droppedColumnSchemas);
        }));
    }

    /**
     * Adds columns from metadata which does not exist in the table.
     * Columns are created without keys.
     */
    protected addNewColumns() {
        return Promise.all(this.entityMetadatas.map(async metadata => {
            const tableSchema = this.tableSchemas.find(table => table.name === metadata.table.name);
            if (!tableSchema)
                return;

            // find which columns are new
            const newColumnMetadatas = metadata.columns.filter(columnMetadata => {
                return !tableSchema.columns.find(columnSchema => columnSchema.name === columnMetadata.name);
            });
            if (newColumnMetadatas.length === 0)
                return;

            this.logger.logSchemaBuild(`new columns added: ` + newColumnMetadatas.map(column => column.name).join(", "));

            // create columns in the database
            const newColumnSchemas = this.metadataColumnsToColumnSchemas(newColumnMetadatas);
            tableSchema.addColumns(newColumnSchemas);
            await this.queryRunner.createColumns(tableSchema, newColumnSchemas);
        }));
    }

    /**
     * Update all exist columns which metadata has changed.
     * Still don't create keys. Also we don't touch foreign keys of the changed columns.
     */
    protected updateExistColumns() {
        return Promise.all(this.entityMetadatas.map(async metadata => {
            const tableSchema = this.tableSchemas.find(table => table.name === metadata.table.name);
            if (!tableSchema)
                return;

            const updatedColumnSchemas = tableSchema.findChangedColumns(this.queryRunner, metadata.columns);
            if (updatedColumnSchemas.length === 0)
                return;

            this.logger.logSchemaBuild(`columns changed in ${tableSchema.name}. updating: ` + updatedColumnSchemas.map(column => column.name).join(", "));

            // drop all foreign keys that point to this column
            const dropRelatedForeignKeysPromises = updatedColumnSchemas
                .filter(changedColumnSchema => !!metadata.columns.find(columnMetadata => columnMetadata.name === changedColumnSchema.name))
                .map(changedColumnSchema => this.dropColumnReferencedForeignKeys(metadata.table.name, changedColumnSchema.name));

            // wait until all related foreign keys are dropped
            await Promise.all(dropRelatedForeignKeysPromises);

            // generate a map of new/old columns
            const newAndOldColumnSchemas = updatedColumnSchemas.map(changedColumnSchema => {
                const columnMetadata = metadata.columns.find(column => column.name === changedColumnSchema.name);
                const newColumnSchema = ColumnSchema.create(columnMetadata!, this.queryRunner.normalizeType(columnMetadata!));
                tableSchema.replaceColumn(changedColumnSchema, newColumnSchema);

                return {
                    newColumn: newColumnSchema,
                    oldColumn: changedColumnSchema
                };
            });

            return this.queryRunner.changeColumns(tableSchema, newAndOldColumnSchemas);
        }));
    }

    /**
     * Creates primary keys which does not exist in the table yet.
     */
    protected updatePrimaryKeys() {
        return Promise.all(this.entityMetadatas.map(async metadata => {
            const tableSchema = this.tableSchemas.find(table => table.name === metadata.table.name);
            if (!tableSchema)
                return;

            const metadataPrimaryColumns = metadata.columns.filter(column => column.isPrimary && !column.isGenerated);
            const addedKeys = metadataPrimaryColumns
                .filter(primaryKey => {
                    return !tableSchema.primaryKeysWithoutGenerated.find(dbPrimaryKey => dbPrimaryKey.columnName === primaryKey.name);
                })
                .map(primaryKey => new PrimaryKeySchema("", primaryKey.name));

            const droppedKeys = tableSchema.primaryKeysWithoutGenerated.filter(primaryKeySchema => {
                return !metadataPrimaryColumns.find(primaryKeyMetadata => primaryKeyMetadata.name === primaryKeySchema.columnName);
            });

            if (addedKeys.length === 0 && droppedKeys.length === 0)
                return;

            this.logger.logSchemaBuild(`primary keys of ${tableSchema.name} has changed: dropped - ${droppedKeys.map(key => key.columnName).join(", ") || "nothing"}; added - ${addedKeys.map(key => key.columnName).join(", ") || "nothing"}`);
            tableSchema.addPrimaryKeys(addedKeys);
            tableSchema.removePrimaryKeys(droppedKeys);
            await this.queryRunner.updatePrimaryKeys(tableSchema);
        }));
    }

    /**
     * Creates foreign keys which does not exist in the table yet.
     */
    protected createForeignKeys() {
        return Promise.all(this.entityMetadatas.map(async metadata => {
            const tableSchema = this.tableSchemas.find(table => table.name === metadata.table.name);
            if (!tableSchema)
                return;

            const newKeys = metadata.foreignKeys.filter(foreignKey => {
                return !tableSchema.foreignKeys.find(dbForeignKey => dbForeignKey.name === foreignKey.name);
            });
            if (newKeys.length === 0)
                return;

            const dbForeignKeys = newKeys.map(foreignKeyMetadata => ForeignKeySchema.create(foreignKeyMetadata));
            this.logger.logSchemaBuild(`creating a foreign keys: ${newKeys.map(key => key.name).join(", ")}`);
            await this.queryRunner.createForeignKeys(tableSchema, dbForeignKeys);
            tableSchema.addForeignKeys(dbForeignKeys);
        }));
    }

    /**
     * Creates indices which are missing in db yet, and drops indices which exist in the db,
     * but does not exist in the metadata anymore.
     */
    protected createIndices() {
        // return Promise.all(this.entityMetadatas.map(metadata => this.createIndices(metadata.table, metadata.indices)));
        return Promise.all(this.entityMetadatas.map(async metadata => {
            const tableSchema = this.tableSchemas.find(table => table.name === metadata.table.name);
            if (!tableSchema)
                return;

            // drop all indices that exist in the table, but does not exist in the given composite indices
            const dropQueries = tableSchema.indices
                .filter(indexSchema => !metadata.indices.find(indexMetadata => indexMetadata.name === indexSchema.name))
                .map(async indexSchema => {
                    this.logger.logSchemaBuild(`dropping an index: ${indexSchema.name}`);
                    tableSchema.removeIndex(indexSchema);
                    await this.queryRunner.dropIndex(metadata.table.name, indexSchema.name);
                });

            // then create table indices for all composite indices we have
            const addQueries = metadata.indices
                .filter(indexMetadata => !tableSchema.indices.find(indexSchema => indexSchema.name === indexMetadata.name))
                .map(async indexMetadata => {
                    const indexSchema = IndexSchema.create(indexMetadata);
                    tableSchema.indices.push(indexSchema);
                    this.logger.logSchemaBuild(`adding new index: ${indexSchema.name}`);
                    await this.queryRunner.createIndex(indexSchema);
                });

            await Promise.all(dropQueries.concat(addQueries));
        }));
    }

    /**
     * Drops all foreign keys of the given column.
     */
    protected async dropColumnReferencedForeignKeys(tableName: string, columnName: string): Promise<void> {

        const allForeignKeyMetadatas = this.entityMetadatas.reduce(
            (all, metadata) => all.concat(metadata.foreignKeys),
            [] as ForeignKeyMetadata[]
        );

        const tableSchema = this.tableSchemas.find(table => table.name === tableName);
        if (!tableSchema)
            return;

        // find depend foreign keys to drop them
        const dependForeignKeys = allForeignKeyMetadatas.filter(foreignKey => {
            if (foreignKey.tableName === tableName) {
                return !!foreignKey.columns.find(fkColumn => {
                    return fkColumn.name === columnName;
                });
            } else if (foreignKey.referencedTableName === tableName) {
                return !!foreignKey.referencedColumns.find(fkColumn => {
                    return fkColumn.name === columnName;
                });
            }
            return false;
        });
        if (!dependForeignKeys.length)
            return;

        const dependForeignKeyInTable = dependForeignKeys.filter(fk => {
            return !!tableSchema.foreignKeys.find(dbForeignKey => dbForeignKey.name === fk.name);
        });
        if (dependForeignKeyInTable.length === 0)
            return;

        this.logger.logSchemaBuild(`dropping related foreign keys of ${tableName}: ${dependForeignKeyInTable.map(foreignKey => foreignKey.name).join(", ")}`);
        const foreignKeySchemas = dependForeignKeyInTable.map(foreignKeyMetadata => ForeignKeySchema.create(foreignKeyMetadata));
        tableSchema.removeForeignKeys(foreignKeySchemas);
        await this.queryRunner.dropForeignKeys(tableSchema, foreignKeySchemas);
    }

    /**
     * Creates new column schemas from the given column metadatas.
     */
    protected metadataColumnsToColumnSchemas(columns: ColumnMetadata[]): ColumnSchema[] {
        return columns.map(columnMetadata => {
            return ColumnSchema.create(columnMetadata, this.queryRunner.normalizeType(columnMetadata));
        });
    }

}